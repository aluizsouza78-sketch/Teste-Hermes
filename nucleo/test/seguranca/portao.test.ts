import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { criarDbTeste, type Db } from '../../src/db/cliente.js';
import { aprovacoes, auditoria, decisoesPolitica, niveisAutonomia, servicosContratados } from '../../src/db/schema.js';
import {
  criarCliente,
  contratarServico,
  resolverClientePorCanal,
  vincularCanal,
  ServicoInexistente,
} from '../../src/clientes/repositorio.js';
import { carregarCatalogo, type Catalogo } from '../../src/catalogo/carregar.js';
import { criarDemanda } from '../../src/esteira/servico.js';
import type { ConfigPolitica, DefinicaoFerramenta } from '../../src/seguranca/politica.js';
import { autorizarChamada, definirAutonomia } from '../../src/seguranca/portao.js';
import { pausar } from '../../src/seguranca/pausas.js';

const argsSchema = z.object({ clienteId: z.string().optional(), repo: z.string().optional() });
const cfg: ConfigPolitica = {
  ferramentas: new Map<string, DefinicaoFerramenta>([
    ['ler_repo', { nome: 'ler_repo', classe: 'leitura', argumentos: argsSchema, permitidaEmN3: false }],
    ['publicar', { nome: 'publicar', classe: 'irreversivel_ou_externa', argumentos: argsSchema, permitidaEmN3: false }],
    ['apagar', { nome: 'apagar', classe: 'escrita_reversivel', argumentos: argsSchema, permitidaEmN3: false }],
  ]),
  permissoes: { dev: ['ler_repo', 'publicar'] },
};

/** Nível efetivo (ausente → N2, como no Portão). */
async function nivelDe(db: Db, clienteId: string, servicoId: string): Promise<string> {
  const [r] = await db
    .select({ n: niveisAutonomia.nivel })
    .from(niveisAutonomia)
    .where(and(eq(niveisAutonomia.clienteId, clienteId), eq(niveisAutonomia.servicoId, servicoId)));
  return r?.n ?? 'N2';
}
async function contratos(db: Db, clienteId: string, servicoId: string) {
  return db
    .select()
    .from(servicosContratados)
    .where(and(eq(servicosContratados.clienteId, clienteId), eq(servicosContratados.servicoId, servicoId)));
}

describe('autorizarChamada', () => {
  let db: Db;
  let clienteA: string;
  let clienteB: string;
  let dA: string;
  let catalogo: Catalogo;
  beforeEach(async () => {
    db = await criarDbTeste();
    catalogo = await carregarCatalogo('catalogo');
    clienteA = (await criarCliente(db, { nome: 'A' }, 'operador')).id;
    clienteB = (await criarCliente(db, { nome: 'B' }, 'operador')).id;
    await contratarServico(db, clienteA, 'sob-medida', {}, catalogo, 'operador');
    await contratarServico(db, clienteB, 'sob-medida', {}, catalogo, 'operador');
    dA = (await criarDemanda(db, { clienteId: clienteA, servicoId: 'sob-medida', titulo: 'X' }, { tipo: 'operador' })).id;
  });

  it('usa o clienteId da demanda, não o do argumento, e grava a decisão', async () => {
    const r = await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'ler_repo', argumentos: { clienteId: clienteA, repo: 'r' } });
    expect(r).toEqual({ decisao: 'permitir', motivo: 'nivel_N2' });
    const ds = await db.select().from(decisoesPolitica);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      demandaId: dA,
      clienteId: clienteA,
      agente: 'dev',
      ferramenta: 'ler_repo',
      argumentos: { clienteId: clienteA, repo: 'r' },
      nivelAutonomia: 'N2',
      decisao: 'permitir',
      motivo: 'nivel_N2',
    });
  });

  it('escopo_cliente rebaixa o serviço daquele cliente para N1 e audita', async () => {
    const r = await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'ler_repo', argumentos: { clienteId: clienteB } });
    expect(r).toEqual({ decisao: 'negar', motivo: 'escopo_cliente' });
    expect(await nivelDe(db, clienteA, 'sob-medida')).toBe('N1');
    expect(await nivelDe(db, clienteB, 'sob-medida')).toBe('N2');
    const [d] = await db.select().from(decisoesPolitica);
    expect(d).toMatchObject({ clienteId: clienteA, decisao: 'negar', motivo: 'escopo_cliente' });
    const [a] = await db.select().from(auditoria).where(eq(auditoria.acao, 'autonomia.rebaixada'));
    expect(a.detalhes).toEqual({ clienteId: clienteA, servicoId: 'sob-medida', de: 'N2', para: 'N1', motivo: 'escopo_cliente' });
  });

  it('ferramenta_nao_permitida rebaixa para N1, inclusive sem contrato existente', async () => {
    const dSem = (await criarDemanda(db, { clienteId: clienteB, servicoId: 'planilha-dashboard', titulo: 'Y' }, { tipo: 'operador' })).id;
    const r = await autorizarChamada(db, cfg, { demandaId: dSem, agente: 'dev', ferramenta: 'apagar', argumentos: {} });
    expect(r).toEqual({ decisao: 'negar', motivo: 'ferramenta_nao_permitida' });
    expect(await nivelDe(db, clienteB, 'planilha-dashboard')).toBe('N1');
    expect(await nivelDe(db, clienteB, 'sob-medida')).toBe('N2');
  });

  it('rebaixamento em serviço não contratado não cria contrato fantasma', async () => {
    await vincularCanal(db, clienteB, { tipo: 'email', identificador: 'b@x.com' }, 'operador');
    const antes = await resolverClientePorCanal(db, 'email', 'b@x.com');
    const dSem = (await criarDemanda(db, { clienteId: clienteB, servicoId: 'planilha-dashboard', titulo: 'Y' }, { tipo: 'operador' })).id;
    await autorizarChamada(db, cfg, { demandaId: dSem, agente: 'dev', ferramenta: 'apagar', argumentos: {} });
    expect(await nivelDe(db, clienteB, 'planilha-dashboard')).toBe('N1');
    expect(await contratos(db, clienteB, 'planilha-dashboard')).toHaveLength(0);
    expect(await resolverClientePorCanal(db, 'email', 'b@x.com')).toEqual(antes);

    await contratarServico(db, clienteB, 'planilha-dashboard', { planilha: 'p1' }, catalogo, 'operador');
    const [c] = await contratos(db, clienteB, 'planilha-dashboard');
    expect(c.configuracao).toEqual({ planilha: 'p1' });
    const aud = await db.select().from(auditoria).where(eq(auditoria.acao, 'servico.contratado'));
    expect(aud.map((a) => a.detalhes)).toContainEqual({ servicoId: 'planilha-dashboard' });
    expect(await nivelDe(db, clienteB, 'planilha-dashboard')).toBe('N1');
  });

  it('rebaixamento nunca eleva o nível', async () => {
    await definirAutonomia(db, catalogo, clienteA, 'sob-medida', 'N0', 'operador', 'restrito');
    await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'ler_repo', argumentos: { clienteId: clienteB } });
    expect(await nivelDe(db, clienteA, 'sob-medida')).toBe('N0');
    expect(await db.select().from(auditoria).where(eq(auditoria.acao, 'autonomia.rebaixada'))).toHaveLength(0);
  });

  it('outras negações não rebaixam, mas são gravadas', async () => {
    const r = await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'nao_existe', argumentos: {} });
    expect(r).toEqual({ decisao: 'negar', motivo: 'ferramenta_desconhecida' });
    expect(await nivelDe(db, clienteA, 'sob-medida')).toBe('N2');
    expect(await db.select().from(decisoesPolitica)).toHaveLength(1);
  });

  it('exigir_aprovacao cria aprovação "acao" com ferramenta e argumentos exatos', async () => {
    const argumentos = { repo: 'site', clienteId: clienteA };
    const r = await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'publicar', argumentos });
    expect(r.decisao).toBe('exigir_aprovacao');
    expect(r.motivo).toBe('nivel_N2');
    expect(r.aprovacaoId).toBeDefined();
    const [ap] = await db.select().from(aprovacoes).where(eq(aprovacoes.id, r.aprovacaoId!));
    expect(ap).toMatchObject({ demandaId: dA, tipo: 'acao', status: 'pendente', detalhes: { ferramenta: 'publicar', argumentos } });
  });

  it('nível rebaixado passa a valer na chamada seguinte', async () => {
    await definirAutonomia(db, catalogo, clienteA, 'sob-medida', 'N0', 'operador', 'cliente sensível');
    const r = await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'ler_repo', argumentos: {} });
    expect(r.decisao).toBe('exigir_aprovacao');
    expect(r.motivo).toBe('nivel_N0');
  });

  it('pausa ativa nega com motivo pausado', async () => {
    await pausar(db, { escopo: 'cliente', alvo: clienteA, motivo: 'incidente' });
    const r = await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'ler_repo', argumentos: {} });
    expect(r).toEqual({ decisao: 'negar', motivo: 'pausado' });
  });

  it('decisoes_politica rejeita UPDATE/DELETE', async () => {
    await autorizarChamada(db, cfg, { demandaId: dA, agente: 'dev', ferramenta: 'ler_repo', argumentos: {} });
    const erro = (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e);
    await expect(db.update(decisoesPolitica).set({ motivo: 'x' })).rejects.toSatisfy((e) => erro(e).includes('somente inserção'));
    await expect(db.delete(decisoesPolitica)).rejects.toSatisfy((e) => erro(e).includes('somente inserção'));
    expect(await db.select().from(decisoesPolitica)).toHaveLength(1);
  });
});

describe('definirAutonomia', () => {
  let db: Db;
  let clienteA: string;
  let catalogo: Catalogo;
  beforeEach(async () => {
    db = await criarDbTeste();
    catalogo = await carregarCatalogo('catalogo');
    clienteA = (await criarCliente(db, { nome: 'A' }, 'operador')).id;
  });

  it('define o nível (sem criar contrato) e audita', async () => {
    await definirAutonomia(db, catalogo, clienteA, 'sob-medida', 'N3', 'operador', 'cliente maduro');
    expect(await nivelDe(db, clienteA, 'sob-medida')).toBe('N3');
    expect(await contratos(db, clienteA, 'sob-medida')).toHaveLength(0);
    await definirAutonomia(db, catalogo, clienteA, 'sob-medida', 'N1', 'operador', 'voltar');
    expect(await nivelDe(db, clienteA, 'sob-medida')).toBe('N1');
    const as = await db.select().from(auditoria).where(eq(auditoria.acao, 'autonomia.definida')).orderBy(auditoria.criadoEm);
    expect(as.map((a) => a.detalhes)).toEqual([
      { clienteId: clienteA, servicoId: 'sob-medida', de: 'N2', para: 'N3', justificativa: 'cliente maduro' },
      { clienteId: clienteA, servicoId: 'sob-medida', de: 'N3', para: 'N1', justificativa: 'voltar' },
    ]);
    expect(as[0].ator).toBe('operador');
  });

  it('exige justificativa', async () => {
    await expect(definirAutonomia(db, catalogo, clienteA, 'sob-medida', 'N3', 'operador', '  ')).rejects.toThrow(/justificativa/);
    expect(await db.select().from(niveisAutonomia)).toHaveLength(0);
  });

  it('servicoId fora do catálogo lança ServicoInexistente', async () => {
    await expect(definirAutonomia(db, catalogo, clienteA, 'nao-existe', 'N3', 'operador', 'x')).rejects.toBeInstanceOf(ServicoInexistente);
    expect(await db.select().from(niveisAutonomia)).toHaveLength(0);
  });
});
