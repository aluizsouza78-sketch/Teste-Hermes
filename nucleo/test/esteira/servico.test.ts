import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, count } from 'drizzle-orm';
import { criarDbTeste, type Db } from '../../src/db/cliente.js';
import { aprovacoes, auditoria, demandas } from '../../src/db/schema.js';
import { criarCliente } from '../../src/clientes/repositorio.js';
import { SERVICO_SOB_MEDIDA } from '../../src/catalogo/carregar.js';
import { TransicaoInvalida, AtorNaoAutorizado, type Ator } from '../../src/esteira/maquina.js';
import {
  criarDemanda,
  executarAcao,
  decidirAprovacao,
  listarAprovacoesPendentes,
  listarDemandas,
  obterDemanda,
  AprovacaoJaDecidida,
  AprovacaoNaoEncontrada,
  DemandaNaoEncontrada,
} from '../../src/esteira/servico.js';

const agente: Ator = { tipo: 'agente', nome: 'construtor' };
const operador: Ator = { tipo: 'operador' };

async function contarAprovacoes(db: Db, demandaId: string, status: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(aprovacoes)
    .where(and(eq(aprovacoes.demandaId, demandaId), eq(aprovacoes.status, status)));
  return r.n;
}
async function contarAuditoria(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(auditoria);
  return r.n;
}
async function pendente(db: Db, demandaId: string, tipo: string) {
  const [a] = await db.select().from(aprovacoes)
    .where(and(eq(aprovacoes.demandaId, demandaId), eq(aprovacoes.tipo, tipo), eq(aprovacoes.status, 'pendente')));
  return a;
}

describe('serviço da esteira', () => {
  let db: Db;
  let clienteId: string;
  beforeEach(async () => {
    db = await criarDbTeste();
    clienteId = (await criarCliente(db, { nome: 'Acme' }, 'operador')).id;
  });
  const nova = (titulo = 'Planilha') => criarDemanda(db, { clienteId, servicoId: 'planilha-dashboard', titulo }, operador);

  async function ateConstrucao(id: string) {
    await executarAcao(db, id, 'submeter_escopo', agente);
    await decidirAprovacao(db, (await pendente(db, id, 'escopo')).id, 'aprovar', null);
  }
  async function ateQa(id: string) {
    await ateConstrucao(id);
    await executarAcao(db, id, 'concluir_construcao', agente);
  }

  it('criarDemanda começa em escopo e audita', async () => {
    const d = await nova();
    const o = await obterDemanda(db, d.id);
    expect(o).toMatchObject({ etapa: 'escopo', tentativasQa: 0, titulo: 'Planilha', clienteId });
    const [a] = await db.select().from(auditoria).where(eq(auditoria.acao, 'demanda.criada'));
    expect(a.alvoId).toBe(d.id);
    expect(a.ator).toBe('operador');
  });

  it('obterDemanda lança DemandaNaoEncontrada', async () => {
    await expect(obterDemanda(db, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(DemandaNaoEncontrada);
  });

  it('fluxo feliz até operação abre e fecha 2 aprovações', async () => {
    const d = await nova();
    await ateQa(d.id);
    await executarAcao(db, d.id, 'qa_aprovado', agente);
    await decidirAprovacao(db, (await pendente(db, d.id, 'entrega')).id, 'aprovar', 'ok');
    const estado = await executarAcao(db, d.id, 'producao_ok', agente);
    expect(estado.etapa).toBe('operacao');
    expect(await contarAprovacoes(db, d.id, 'aprovada')).toBe(2);
    const trans = await db.select().from(auditoria).where(eq(auditoria.acao, 'demanda.transicao'));
    expect(trans).toHaveLength(6);
    const [a] = await db.select().from(auditoria).where(eq(auditoria.acao, 'aprovacao.decidida'));
    expect(a.ator).toBe('operador');
  });

  it('atualiza atualizado_em a cada transição', async () => {
    const d = await nova();
    const [antes] = await db.select().from(demandas).where(eq(demandas.id, d.id));
    await new Promise((r) => setTimeout(r, 10));
    await executarAcao(db, d.id, 'submeter_escopo', agente);
    const [depois] = await db.select().from(demandas).where(eq(demandas.id, d.id));
    expect(depois.atualizadoEm.getTime()).toBeGreaterThan(antes.atualizadoEm.getTime());
  });

  it('recusar escopo volta a escopo e registra comentário na auditoria', async () => {
    const d = await nova();
    await executarAcao(db, d.id, 'submeter_escopo', agente);
    const e = await decidirAprovacao(db, (await pendente(db, d.id, 'escopo')).id, 'recusar', 'falta detalhe');
    expect(e.etapa).toBe('escopo');
    const [a] = await db.select().from(auditoria).where(eq(auditoria.acao, 'aprovacao.decidida'));
    expect(JSON.stringify(a.detalhes)).toContain('falta detalhe');
  });

  it('3 reprovações de QA escalam e abrem aprovação de escalada', async () => {
    const d = await nova();
    await ateQa(d.id);
    await executarAcao(db, d.id, 'qa_reprovado', agente);
    await executarAcao(db, d.id, 'concluir_construcao', agente);
    await executarAcao(db, d.id, 'qa_reprovado', agente);
    await executarAcao(db, d.id, 'concluir_construcao', agente);
    const e = await executarAcao(db, d.id, 'qa_reprovado', agente);
    expect(e).toEqual({ etapa: 'escalada', tentativasQa: 3 });
    const ap = await pendente(db, d.id, 'escalada');
    expect(ap.detalhes).toEqual({ motivo: 'limite_tentativas_qa' });
  });

  it('decidir escalada com aprovar retoma em construção com tentativas zeradas', async () => {
    const d = await nova();
    await executarAcao(db, d.id, 'escalar', agente, 'travou');
    const ap = await pendente(db, d.id, 'escalada');
    expect(ap.detalhes).toEqual({ motivo: 'travou' });
    const e = await decidirAprovacao(db, ap.id, 'aprovar', null);
    expect(e).toEqual({ etapa: 'construcao', tentativasQa: 0 });
  });

  it('decidir escalada com recusar cancela', async () => {
    const d = await nova();
    await executarAcao(db, d.id, 'escalar', agente, 'travou');
    const e = await decidirAprovacao(db, (await pendente(db, d.id, 'escalada')).id, 'recusar', null);
    expect(e.etapa).toBe('cancelada');
  });

  it('decisão dupla: segunda lança AprovacaoJaDecidida e não transiciona de novo', async () => {
    const d = await nova();
    await executarAcao(db, d.id, 'submeter_escopo', agente);
    const ap = await pendente(db, d.id, 'escopo');
    await decidirAprovacao(db, ap.id, 'aprovar', null);
    await expect(decidirAprovacao(db, ap.id, 'aprovar', null)).rejects.toBeInstanceOf(AprovacaoJaDecidida);
    expect((await obterDemanda(db, d.id)).etapa).toBe('construcao');
  });

  it('decisões concorrentes: apenas uma vence', async () => {
    const d = await nova();
    await executarAcao(db, d.id, 'submeter_escopo', agente);
    const ap = await pendente(db, d.id, 'escopo');
    const r = await Promise.allSettled([
      decidirAprovacao(db, ap.id, 'aprovar', null),
      decidirAprovacao(db, ap.id, 'recusar', null),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')[0]).toMatchObject({ reason: expect.any(AprovacaoJaDecidida) });
  });

  it('aprovação inexistente lança AprovacaoNaoEncontrada', async () => {
    await expect(decidirAprovacao(db, '00000000-0000-0000-0000-000000000000', 'aprovar', null))
      .rejects.toBeInstanceOf(AprovacaoNaoEncontrada);
  });

  it('ação inválida não altera banco nem auditoria', async () => {
    const d = await nova();
    const antes = await contarAuditoria(db);
    await expect(executarAcao(db, d.id, 'qa_aprovado', agente)).rejects.toBeInstanceOf(TransicaoInvalida);
    expect(await contarAuditoria(db)).toBe(antes);
    expect((await obterDemanda(db, d.id)).etapa).toBe('escopo');
  });

  it('agente não pode cancelar (ator não autorizado)', async () => {
    const d = await nova();
    await expect(executarAcao(db, d.id, 'cancelar', agente)).rejects.toBeInstanceOf(AtorNaoAutorizado);
  });

  it('operador cancela via executarAcao', async () => {
    const d = await nova();
    expect((await executarAcao(db, d.id, 'cancelar', operador, 'desistiu')).etapa).toBe('cancelada');
  });

  it('demanda inexistente em executarAcao lança DemandaNaoEncontrada', async () => {
    await expect(executarAcao(db, '00000000-0000-0000-0000-000000000000', 'submeter_escopo', agente))
      .rejects.toBeInstanceOf(DemandaNaoEncontrada);
  });

  it('falha em produção escala e cria demanda de investigação sob-medida', async () => {
    const d = await nova('Relatório X');
    await ateQa(d.id);
    await executarAcao(db, d.id, 'qa_aprovado', agente);
    await decidirAprovacao(db, (await pendente(db, d.id, 'entrega')).id, 'aprovar', null);
    const e = await executarAcao(db, d.id, 'producao_falhou', agente);
    expect(e.etapa).toBe('escalada');
    const lista = await listarDemandas(db, { clienteId });
    const inv = lista.find((x) => x.id !== d.id);
    expect(inv).toMatchObject({
      servicoId: SERVICO_SOB_MEDIDA,
      titulo: 'Investigar falha em produção: Relatório X',
      etapa: 'escopo',
      clienteId,
    });
  });

  it('listarDemandas filtra por cliente', async () => {
    const outro = (await criarCliente(db, { nome: 'Outro' }, 'operador')).id;
    await nova();
    await criarDemanda(db, { clienteId: outro, servicoId: 'x', titulo: 'Y' }, operador);
    expect(await listarDemandas(db, { clienteId })).toHaveLength(1);
    expect(await listarDemandas(db, { clienteId: outro })).toHaveLength(1);
    expect(await listarDemandas(db, {})).toHaveLength(2);
  });

  it('listarAprovacoesPendentes traz cliente e título', async () => {
    const d = await nova('T1');
    await executarAcao(db, d.id, 'submeter_escopo', agente);
    const l = await listarAprovacoesPendentes(db);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tipo: 'escopo', demandaId: d.id, clienteNome: 'Acme', tituloDemanda: 'T1' });
    await decidirAprovacao(db, l[0].id, 'aprovar', null);
    expect(await listarAprovacoesPendentes(db)).toHaveLength(0);
  });

  it('cancelar durante aguardando aprovação fecha aprovações pendentes (escopo e acao)', async () => {
    const d = await nova();
    await executarAcao(db, d.id, 'submeter_escopo', agente);
    const [acao] = await db.insert(aprovacoes).values({ demandaId: d.id, tipo: 'acao' }).returning();
    const escopo = await pendente(db, d.id, 'escopo');
    expect((await executarAcao(db, d.id, 'cancelar', operador)).etapa).toBe('cancelada');
    expect(await listarAprovacoesPendentes(db)).toHaveLength(0);
    for (const id of [escopo.id, acao.id]) {
      const [r] = await db.select().from(aprovacoes).where(eq(aprovacoes.id, id));
      expect(r.status).toBe('recusada');
      expect(r.comentario).toBe('demanda cancelada');
      expect(r.decididoEm).not.toBeNull();
      const aud = await db.select().from(auditoria).where(and(eq(auditoria.alvoId, id), eq(auditoria.acao, 'aprovacao.decidida')));
      expect(aud).toHaveLength(1);
      expect(aud[0].detalhes).toMatchObject({ automatico: true, motivo: 'demanda_cancelada' });
    }
  });

  it('aprovação do tipo acao só registra a decisão, sem transição', async () => {
    const d = await nova();
    const [ap] = await db.insert(aprovacoes).values({ demandaId: d.id, tipo: 'acao' }).returning();
    const e = await decidirAprovacao(db, ap.id, 'aprovar', 'pode');
    expect(e).toEqual({ etapa: 'escopo', tentativasQa: 0 });
    const [r] = await db.select().from(aprovacoes).where(eq(aprovacoes.id, ap.id));
    expect(r.status).toBe('aprovada');
    expect(r.comentario).toBe('pode');
    expect(r.decididoEm).not.toBeNull();
  });
});
