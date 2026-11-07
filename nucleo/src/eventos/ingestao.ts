import { eq, and } from 'drizzle-orm';
import type { Db } from '../db/cliente.js';
import { eventos } from '../db/schema.js';
import type { Catalogo } from '../catalogo/carregar.js';
import { resolverClientePorCanal, type TipoCanal } from '../clientes/repositorio.js';
import { criarDemanda } from '../esteira/servico.js';
import { Pausado } from '../seguranca/pausas.js';
import { registrarAuditoria } from '../auditoria/registrar.js';
import { LIMIAR_CONFIANCA, type Classificacao, type Classificador } from './classificador.js';

export type EntradaEvento = {
  canalTipo: TipoCanal;
  canalIdentificador: string;
  idExterno: string;
  texto: string;
  recebidoEm: Date;
};

export type StatusIngestao = 'demanda_criada' | 'revisao_humana' | 'cliente_desconhecido' | 'ignorado' | 'duplicado';
type StatusGravado = Exclude<StatusIngestao, 'duplicado'>;

const MAX_RESUMO = 500;
const MAX_TITULO = 120;

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function confiancaValida(c: unknown): c is number {
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1;
}

export async function ingerirEvento(
  db: Db,
  deps: { classificador: Classificador; catalogo: Catalogo },
  e: EntradaEvento,
): Promise<{ eventoId: string; status: StatusIngestao; demandaId?: string }> {
  // Unicidade decidida pelo índice único (sem corrida check-then-insert).
  const [novo] = await db
    .insert(eventos)
    .values({
      canalTipo: e.canalTipo,
      canalIdentificador: e.canalIdentificador,
      idExterno: e.idExterno,
      texto: e.texto,
      recebidoEm: e.recebidoEm,
      origemConfianca: 'cliente',
      status: 'recebido',
    })
    .onConflictDoNothing()
    .returning({ id: eventos.id });
  if (!novo) {
    const [existente] = await db
      .select({ id: eventos.id })
      .from(eventos)
      .where(and(eq(eventos.canalTipo, e.canalTipo), eq(eventos.idExterno, e.idExterno)));
    return { eventoId: existente.id, status: 'duplicado' };
  }
  const eventoId = novo.id;

  const finalizar = async (
    status: StatusGravado,
    campos: { clienteId?: string; servicoId?: string; confianca?: number; resumo?: string },
    demandaId?: string,
  ) => {
    await db
      .update(eventos)
      .set({
        status,
        clienteId: campos.clienteId ?? null,
        servicoId: campos.servicoId ?? null,
        confianca: campos.confianca ?? null,
        resumo: campos.resumo ?? null,
      })
      .where(eq(eventos.id, eventoId));
    await registrarAuditoria(db, {
      ator: 'sistema',
      acao: 'evento.recebido',
      alvoTipo: 'evento',
      alvoId: eventoId,
      detalhes: { status, clienteId: campos.clienteId ?? null },
    });
    return demandaId === undefined ? { eventoId, status } : { eventoId, status, demandaId };
  };

  const cliente = await resolverClientePorCanal(db, e.canalTipo, e.canalIdentificador);
  if (!cliente) return finalizar('cliente_desconhecido', {});
  const clienteId = cliente.id;

  let c: Classificacao;
  try {
    c = await deps.classificador.classificar({
      texto: e.texto,
      clienteNome: cliente.nome,
      servicosContratados: cliente.servicosContratados,
      servicosCatalogo: deps.catalogo.listar(),
    });
  } catch (err) {
    return finalizar('revisao_humana', { clienteId, resumo: `falha na classificação: ${mensagemDe(err)}`.slice(0, MAX_RESUMO) });
  }

  if (!c || !confiancaValida(c.confianca) || typeof c.servicoId !== 'string') {
    return finalizar('revisao_humana', { clienteId, resumo: 'falha na classificação: saída inválida' });
  }
  const resumo = String(c.resumo ?? '').slice(0, MAX_RESUMO);
  const titulo = String(c.titulo ?? '').slice(0, MAX_TITULO);
  const base = { clienteId, servicoId: c.servicoId, confianca: c.confianca, resumo };

  if (c.confianca < LIMIAR_CONFIANCA) return finalizar('revisao_humana', base);
  if (c.servicoId === 'ignorar') return finalizar('ignorado', base);
  if (!deps.catalogo.obter(c.servicoId) || titulo.trim() === '') return finalizar('revisao_humana', base);

  try {
    const d = await criarDemanda(
      db,
      { clienteId, servicoId: c.servicoId, titulo, eventoId },
      { tipo: 'agente', nome: 'gestor' },
    );
    return await finalizar('demanda_criada', base, d.id);
  } catch (err) {
    if (err instanceof Pausado) return finalizar('revisao_humana', { ...base, resumo: `pausado: ${resumo}`.slice(0, MAX_RESUMO) });
    throw err;
  }
}
