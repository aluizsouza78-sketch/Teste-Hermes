import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { criarDbTeste, type Db } from '../../src/db/cliente.js';
import { auditoria, execucoesAgente, orcamentos } from '../../src/db/schema.js';
import { criarCliente } from '../../src/clientes/repositorio.js';
import { criarDemanda, executarAcao, obterDemanda } from '../../src/esteira/servico.js';
import { pausar } from '../../src/seguranca/pausas.js';
import {
  ExecucaoEncerrada,
  ExecucaoNaoEncontrada,
  LIMITES_EXECUCAO,
  OrcamentoEsgotado,
  avaliarLimites,
  finalizarExecucao,
  iniciarExecucao,
  registrarConsumo,
} from '../../src/seguranca/orcamento.js';
import { Pausado } from '../../src/seguranca/pausas.js';

const zerado = {
  turnos: 0, chamadasFerramenta: 0, tokens: 0, minutos: 0, gastoDiaClienteCentavos: 0, gastoDiaGlobalCentavos: 0,
};
const semDiario = { porExecucao: LIMITES_EXECUCAO, diarioClienteCentavos: null, diarioGlobalCentavos: null };

describe('avaliarLimites (pura)', () => {
  it('dentro dos limites continua', () => {
    expect(avaliarLimites(zerado, semDiario)).toEqual({ continuar: true, alertas: [] });
  });
  it('exatamente no limite continua', () => {
    const r = avaliarLimites({ ...zerado, turnos: 50, chamadasFerramenta: 100, tokens: 500_000, minutos: 30 }, semDiario);
    expect(r.continuar).toBe(true);
  });
  it.each([
    ['turnos', 51, 'turnos'],
    ['chamadasFerramenta', 101, 'chamadas_ferramenta'],
    ['tokens', 500_001, 'tokens'],
    ['minutos', 31, 'tempo'],
  ] as const)('estourar %s para', (campo, valor, motivo) => {
    expect(avaliarLimites({ ...zerado, [campo]: valor }, semDiario)).toEqual({ continuar: false, motivo, alertas: [] });
  });
  it('80% do orçamento diário do cliente gera alerta e continua', () => {
    expect(avaliarLimites({ ...zerado, gastoDiaClienteCentavos: 800 }, { ...semDiario, diarioClienteCentavos: 1000 }))
      .toEqual({ continuar: true, alertas: ['orcamento_cliente_80'] });
  });
  it('80% do global gera alerta global', () => {
    expect(avaliarLimites({ ...zerado, gastoDiaGlobalCentavos: 800 }, { ...semDiario, diarioGlobalCentavos: 1000 }))
      .toEqual({ continuar: true, alertas: ['orcamento_global_80'] });
  });
  it('79% não alerta', () => {
    expect(avaliarLimites({ ...zerado, gastoDiaClienteCentavos: 790 }, { ...semDiario, diarioClienteCentavos: 1000 }).alertas).toEqual([]);
  });
  it('100% do diário corta', () => {
    expect(avaliarLimites({ ...zerado, gastoDiaClienteCentavos: 1000 }, { ...semDiario, diarioClienteCentavos: 1000 }))
      .toMatchObject({ continuar: false, motivo: 'orcamento_cliente' });
    expect(avaliarLimites({ ...zerado, gastoDiaGlobalCentavos: 1000 }, { ...semDiario, diarioGlobalCentavos: 1000 }))
      .toMatchObject({ continuar: false, motivo: 'orcamento_global' });
  });
  it('limite null = sem limite', () => {
    expect(avaliarLimites({ ...zerado, gastoDiaClienteCentavos: 10 ** 9, gastoDiaGlobalCentavos: 10 ** 9 }, semDiario))
      .toEqual({ continuar: true, alertas: [] });
  });
  it('motivo é o primeiro limite atingido', () => {
    expect(avaliarLimites({ ...zerado, tokens: 600_000, turnos: 60 }, semDiario).motivo).toBe('turnos');
  });
});

describe('execuções de agente', () => {
  let db: Db;
  let clienteId: string;
  let outroCliente: string;
  let demandaId: string;
  const p = (d = demandaId) => ({ demandaId: d, agente: 'construtor', modelo: 'm', versaoPrompt: 'v1' });
  const acoes = async () => (await db.select().from(auditoria)).map((a) => a.acao);

  beforeEach(async () => {
    db = await criarDbTeste();
    clienteId = (await criarCliente(db, { nome: 'A' }, 'operador')).id;
    outroCliente = (await criarCliente(db, { nome: 'B' }, 'operador')).id;
    demandaId = (await criarDemanda(db, { clienteId, servicoId: 'sob-medida', titulo: 'T' }, { tipo: 'operador' })).id;
  });
  const exec = async (id: string) => (await db.select().from(execucoesAgente).where(eq(execucoesAgente.id, id)))[0];

  it('iniciarExecucao registra e audita', async () => {
    const { id } = await iniciarExecucao(db, p());
    expect((await exec(id)).status).toBe('em_andamento');
    expect(await acoes()).toContain('execucao.iniciada');
  });

  it('iniciarExecucao com cliente pausado lança Pausado', async () => {
    await pausar(db, { escopo: 'cliente', alvo: clienteId, motivo: 'x' });
    await expect(iniciarExecucao(db, p())).rejects.toBeInstanceOf(Pausado);
    expect(await db.select().from(execucoesAgente)).toHaveLength(0);
  });

  it('iniciarExecucao com orçamento do dia do cliente esgotado lança OrcamentoEsgotado', async () => {
    await db.insert(orcamentos).values({ escopo: 'cliente', clienteId, limiteDiarioCentavos: 100 });
    const { id } = await iniciarExecucao(db, p());
    await registrarConsumo(db, id, { custoCentavos: 100 }).catch(() => undefined);
    await expect(iniciarExecucao(db, p())).rejects.toBeInstanceOf(OrcamentoEsgotado);
  });

  it('orçamento global esgotado bloqueia qualquer cliente; de outro cliente não bloqueia', async () => {
    await db.insert(orcamentos).values({ escopo: 'cliente', clienteId: outroCliente, limiteDiarioCentavos: 1 });
    const { id } = await iniciarExecucao(db, p());
    await db.update(execucoesAgente).set({ custoCentavos: 500 }).where(eq(execucoesAgente.id, id));
    await expect(iniciarExecucao(db, p())).resolves.toHaveProperty('id'); // limite do outro cliente não vale
    await db.insert(orcamentos).values({ escopo: 'global', limiteDiarioCentavos: 500 });
    await expect(iniciarExecucao(db, p())).rejects.toBeInstanceOf(OrcamentoEsgotado);
  });

  it('gasto de ontem (fuso São Paulo) não conta', async () => {
    await db.insert(orcamentos).values({ escopo: 'cliente', clienteId, limiteDiarioCentavos: 100 });
    const { id } = await iniciarExecucao(db, p());
    await db.update(execucoesAgente).set({ custoCentavos: 500, criadoEm: new Date('2026-01-10T12:00:00Z') }).where(eq(execucoesAgente.id, id));
    const agora = () => new Date('2026-01-11T02:30:00Z'); // 10/01 23:30 em SP: ainda o mesmo dia
    await expect(iniciarExecucao(db, p(), agora)).rejects.toBeInstanceOf(OrcamentoEsgotado);
    const depois = () => new Date('2026-01-11T03:30:00Z'); // 11/01 00:30 em SP: dia novo
    await expect(iniciarExecucao(db, p(), depois)).resolves.toHaveProperty('id');
  });

  it('registrarConsumo acumula e anexa passo ao rastro', async () => {
    const { id } = await iniciarExecucao(db, p());
    const r = await registrarConsumo(db, id, { turnos: 1, chamadasFerramenta: 2, tokens: 10, custoCentavos: 3, passo: { a: 1 } });
    expect(r).toEqual({ continuar: true, alertas: [] });
    await registrarConsumo(db, id, { turnos: 1, passo: { b: 2 } });
    const e = await exec(id);
    expect(e).toMatchObject({ turnos: 2, chamadasFerramenta: 2, tokens: 10, custoCentavos: 3 });
    expect(e.rastro).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('50 turnos continua; 51 interrompe, audita e escala a demanda', async () => {
    const { id } = await iniciarExecucao(db, p());
    expect((await registrarConsumo(db, id, { turnos: 50 })).continuar).toBe(true);
    const r = await registrarConsumo(db, id, { turnos: 1 });
    expect(r).toMatchObject({ continuar: false, motivo: 'turnos' });
    const e = await exec(id);
    expect(e.status).toBe('interrompida_orcamento');
    expect(e.finalizadoEm).not.toBeNull();
    expect((await obterDemanda(db, demandaId)).etapa).toBe('escalada');
    const aud = (await db.select().from(auditoria)).find((a) => a.acao === 'execucao.interrompida');
    expect(aud?.detalhes).toMatchObject({ motivo: 'turnos' });
    const esc = (await db.select().from(auditoria)).find((a) => a.acao === 'demanda.transicao' && (a.detalhes as { acao?: string }).acao === 'escalar');
    expect(esc?.detalhes).toMatchObject({ motivo: 'orcamento_excedido:turnos' });
  });

  it('tempo: minutos desde criado_em com relógio injetável', async () => {
    const t0 = new Date('2026-03-01T10:00:00Z');
    const { id } = await iniciarExecucao(db, p(), () => t0);
    await db.update(execucoesAgente).set({ criadoEm: t0 }).where(eq(execucoesAgente.id, id));
    expect((await registrarConsumo(db, id, {}, () => new Date('2026-03-01T10:30:00Z'))).continuar).toBe(true);
    const r = await registrarConsumo(db, id, {}, () => new Date('2026-03-01T10:31:00Z'));
    expect(r).toMatchObject({ continuar: false, motivo: 'tempo' });
  });

  it('alerta de 80% do cliente continua e audita o alerta', async () => {
    await db.insert(orcamentos).values({ escopo: 'cliente', clienteId, limiteDiarioCentavos: 1000 });
    const { id } = await iniciarExecucao(db, p());
    const r = await registrarConsumo(db, id, { custoCentavos: 800 });
    expect(r).toEqual({ continuar: true, alertas: ['orcamento_cliente_80'] });
    expect(await acoes()).toContain('execucao.alerta_orcamento');
  });

  it('100% do diário do cliente interrompe com orcamento_cliente', async () => {
    await db.insert(orcamentos).values({ escopo: 'cliente', clienteId, limiteDiarioCentavos: 1000 });
    const { id } = await iniciarExecucao(db, p());
    const r = await registrarConsumo(db, id, { custoCentavos: 1000 });
    expect(r).toMatchObject({ continuar: false, motivo: 'orcamento_cliente' });
    expect((await obterDemanda(db, demandaId)).etapa).toBe('escalada');
  });

  it('demanda já escalada: interrupção é mantida e TransicaoInvalida engolida', async () => {
    const { id } = await iniciarExecucao(db, p());
    await executarAcao(db, demandaId, 'escalar', { tipo: 'operador' }, 'manual');
    const r = await registrarConsumo(db, id, { turnos: 51 });
    expect(r.continuar).toBe(false);
    expect((await exec(id)).status).toBe('interrompida_orcamento');
    expect((await obterDemanda(db, demandaId)).etapa).toBe('escalada');
  });

  it('pausa durante a execução: interrompida_pausa, sem escalonar', async () => {
    const { id } = await iniciarExecucao(db, p());
    await pausar(db, { escopo: 'agente', alvo: 'construtor', motivo: 'loop' });
    const r = await registrarConsumo(db, id, { turnos: 1 });
    expect(r).toEqual({ continuar: false, motivo: 'pausado', alertas: [] });
    expect((await exec(id)).status).toBe('interrompida_pausa');
    expect((await obterDemanda(db, demandaId)).etapa).toBe('escopo');
  });

  it('execução encerrada lança ExecucaoEncerrada; inexistente lança ExecucaoNaoEncontrada', async () => {
    const { id } = await iniciarExecucao(db, p());
    await finalizarExecucao(db, id, 'concluida');
    const e = await exec(id);
    expect(e.status).toBe('concluida');
    expect(e.finalizadoEm).not.toBeNull();
    expect(await acoes()).toContain('execucao.finalizada');
    await expect(registrarConsumo(db, id, { turnos: 1 })).rejects.toBeInstanceOf(ExecucaoEncerrada);
    await expect(registrarConsumo(db, '00000000-0000-0000-0000-000000000000', {})).rejects.toBeInstanceOf(ExecucaoNaoEncontrada);
  });
});
