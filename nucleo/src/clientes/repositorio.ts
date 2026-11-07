import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/cliente.js';
import { canaisCliente, clientes, servicosContratados } from '../db/schema.js';
import { registrarAuditoria } from '../auditoria/registrar.js';
import type { Catalogo } from '../catalogo/carregar.js';

export type TipoCanal = 'whatsapp_grupo' | 'whatsapp_contato' | 'email';

export class CanalJaVinculado extends Error {
  constructor(
    public readonly clienteIdAtual: string,
    public readonly tipo: TipoCanal,
    public readonly identificador: string,
  ) {
    super(`Canal ${tipo}:${identificador} já está vinculado ao cliente ${clienteIdAtual}`);
    this.name = 'CanalJaVinculado';
  }
}

export class ServicoInexistente extends Error {
  constructor(public readonly servicoId: string) {
    super(`Serviço inexistente no catálogo: ${servicoId}`);
    this.name = 'ServicoInexistente';
  }
}

function normalizar(tipo: TipoCanal, identificador: string): string {
  return tipo === 'email' ? identificador.replace(/\s+/g, '').toLowerCase() : identificador;
}

export async function criarCliente(
  db: Db,
  dados: { nome: string; contatos?: unknown[]; cofreRef?: string },
  ator: string,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .insert(clientes)
      .values({ nome: dados.nome, contatos: dados.contatos ?? [], cofreRef: dados.cofreRef ?? null })
      .returning({ id: clientes.id });
    await registrarAuditoria(tx, {
      ator,
      acao: 'cliente.criado',
      alvoTipo: 'cliente',
      alvoId: c.id,
      detalhes: { nome: dados.nome },
    });
    return { id: c.id };
  });
}

export async function vincularCanal(
  db: Db,
  clienteId: string,
  canal: { tipo: TipoCanal; identificador: string },
  ator: string,
): Promise<void> {
  const identificador = normalizar(canal.tipo, canal.identificador);
  await db.transaction(async (tx) => {
    // ON CONFLICT evita a corrida check-then-insert: o índice único decide.
    const inseridos = await tx
      .insert(canaisCliente)
      .values({ clienteId, tipo: canal.tipo, identificador })
      .onConflictDoNothing({ target: [canaisCliente.tipo, canaisCliente.identificador] })
      .returning({ id: canaisCliente.id });
    if (inseridos.length === 0) {
      const [existente] = await tx
        .select({ clienteId: canaisCliente.clienteId })
        .from(canaisCliente)
        .where(and(eq(canaisCliente.tipo, canal.tipo), eq(canaisCliente.identificador, identificador)));
      if (existente && existente.clienteId !== clienteId) {
        throw new CanalJaVinculado(existente.clienteId, canal.tipo, identificador);
      }
      return; // já é do mesmo cliente: idempotente, sem nova auditoria
    }
    await registrarAuditoria(tx, {
      ator,
      acao: 'canal.vinculado',
      alvoTipo: 'cliente',
      alvoId: clienteId,
      detalhes: { tipo: canal.tipo, identificador },
    });
  });
}

export async function contratarServico(
  db: Db,
  clienteId: string,
  servicoId: string,
  configuracao: Record<string, unknown>,
  catalogo: Catalogo,
  ator: string,
): Promise<void> {
  if (!catalogo.obter(servicoId)) throw new ServicoInexistente(servicoId);
  await db.transaction(async (tx) => {
    const inseridos = await tx
      .insert(servicosContratados)
      .values({ clienteId, servicoId, configuracao })
      .onConflictDoNothing({ target: [servicosContratados.clienteId, servicosContratados.servicoId] })
      .returning({ id: servicosContratados.id });
    if (inseridos.length === 0) return; // já contratado: idempotente, mantém configuração atual
    await registrarAuditoria(tx, {
      ator,
      acao: 'servico.contratado',
      alvoTipo: 'cliente',
      alvoId: clienteId,
      detalhes: { servicoId },
    });
  });
}

export async function resolverClientePorCanal(
  db: Db,
  tipo: TipoCanal,
  identificador: string,
): Promise<{ id: string; nome: string; servicosContratados: string[] } | null> {
  const [c] = await db
    .select({ id: clientes.id, nome: clientes.nome })
    .from(canaisCliente)
    .innerJoin(clientes, eq(clientes.id, canaisCliente.clienteId))
    .where(and(eq(canaisCliente.tipo, tipo), eq(canaisCliente.identificador, normalizar(tipo, identificador))));
  if (!c) return null;
  const servicos = await db
    .select({ servicoId: servicosContratados.servicoId })
    .from(servicosContratados)
    .where(eq(servicosContratados.clienteId, c.id))
    .orderBy(servicosContratados.servicoId);
  return { id: c.id, nome: c.nome, servicosContratados: servicos.map((s) => s.servicoId) };
}

export async function listarClientes(db: Db): Promise<Array<{ id: string; nome: string; status: string }>> {
  return db.select({ id: clientes.id, nome: clientes.nome, status: clientes.status }).from(clientes).orderBy(clientes.criadoEm);
}
