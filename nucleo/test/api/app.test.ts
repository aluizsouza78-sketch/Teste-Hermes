import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { criarDbTeste, type Db } from '../../src/db/cliente.js';
import { carregarCatalogo, type Catalogo } from '../../src/catalogo/carregar.js';
import { construirApp } from '../../src/api/app.js';
import type { Classificacao, Classificador } from '../../src/eventos/classificador.js';
import type { ConfigPolitica } from '../../src/seguranca/politica.js';

const TOKEN = 'x'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

class ClassificadorFake implements Classificador {
  retorno: Classificacao = { servicoId: 'planilha-dashboard', confianca: 0.95, resumo: 'Quer dashboard', titulo: 'Dashboard de vendas' };
  async classificar(): Promise<Classificacao> {
    return this.retorno;
  }
}

const configPolitica: ConfigPolitica = {
  ferramentas: new Map([
    ['ler_demanda', { nome: 'ler_demanda', classe: 'leitura', argumentos: z.object({ demandaId: z.string().uuid() }), permitidaEmN3: false }],
  ]),
  permissoes: { gestor: ['ler_demanda'] },
};

describe('API HTTP', () => {
  let db: Db;
  let catalogo: Catalogo;
  let app: FastifyInstance;

  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function novoCliente(nome = 'Fiori', canal?: string) {
    const r = await req('POST', '/clientes', { nome });
    const id = r.json().id as string;
    if (canal) await req('POST', `/clientes/${id}/canais`, { tipo: 'whatsapp_grupo', identificador: canal });
    return id;
  }
  async function novaDemanda(canal = 'grupo-fiori') {
    const clienteId = await novoCliente('Fiori', canal);
    const r = await req('POST', '/eventos', {
      canalTipo: 'whatsapp_grupo', canalIdentificador: canal, idExterno: `m-${Math.random()}`,
      texto: 'quero um dashboard', recebidoEm: new Date().toISOString(),
    });
    return { clienteId, demandaId: r.json().demandaId as string, resposta: r };
  }

  beforeEach(async () => {
    db = await criarDbTeste();
    catalogo = await carregarCatalogo('catalogo');
    app = construirApp({ db, catalogo, classificador: new ClassificadorFake(), operadorToken: TOKEN, configPolitica });
  });

  it('sem token → 401; GET /saude sem token → 200', async () => {
    expect((await req('GET', '/clientes', undefined, {})).statusCode).toBe(401);
    expect((await req('GET', '/clientes', undefined, { authorization: 'Bearer errado' })).statusCode).toBe(401);
    expect((await req('GET', '/clientes', undefined, { authorization: `Bearer ${TOKEN}x` })).statusCode).toBe(401);
    expect((await req('GET', '/clientes', undefined, { authorization: TOKEN })).statusCode).toBe(401);
    const s = await req('GET', '/saude', undefined, {});
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual({ ok: true });
    expect((await req('GET', '/clientes')).statusCode).toBe(200);
  });

  it('fluxo: cria cliente, vincula canal, POST /eventos cria demanda, decisão via /aprovacoes', async () => {
    const { clienteId, demandaId, resposta } = await novaDemanda();
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().status).toBe('demanda_criada');
    expect((await req('POST', `/clientes/${clienteId}/servicos`, { servicoId: 'planilha-dashboard' })).statusCode).toBe(204);
    expect((await req('POST', `/clientes/${clienteId}/servicos`, { servicoId: 'nao-existe' })).statusCode).toBe(400);
    expect((await req('GET', '/catalogo')).json().length).toBeGreaterThan(0);
    expect((await req('GET', `/demandas?clienteId=${clienteId}`)).json()).toHaveLength(1);

    const acao = await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'submeter_escopo', agente: 'gestor' });
    expect(acao.statusCode).toBe(200);
    expect(acao.json().etapa).toBe('aguardando_aprovacao_escopo');

    const pend = (await req('GET', '/aprovacoes')).json();
    expect(pend).toHaveLength(1);
    const dec = await req('POST', `/aprovacoes/${pend[0].id}/decisao`, { decisao: 'aprovar', comentario: 'ok' });
    expect(dec.statusCode).toBe(200);
    expect(dec.json().etapa).toBe('construcao');
    expect((await req('GET', '/aprovacoes')).json()).toHaveLength(0);

    const aud = (await req('GET', `/auditoria?alvoId=${demandaId}&limite=5`)).json();
    expect(aud.length).toBeGreaterThan(0);
    expect(aud.length).toBeLessThanOrEqual(5);
    expect((await req('GET', '/auditoria?limite=501')).statusCode).toBe(200);
    expect((await req('GET', '/auditoria?limite=0')).statusCode).toBe(400);
  });

  it('canal duplicado em outro cliente → 409', async () => {
    await novoCliente('A', 'grupo-x');
    const b = await novoCliente('B');
    const r = await req('POST', `/clientes/${b}/canais`, { tipo: 'whatsapp_grupo', identificador: 'grupo-x' });
    expect(r.statusCode).toBe(409);
  });

  it('cliente inexistente → 404 em canais, servicos e autonomia', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await req('POST', `/clientes/${id}/canais`, { tipo: 'email', identificador: 'a@b.c' })).statusCode).toBe(404);
    expect((await req('POST', `/clientes/${id}/servicos`, { servicoId: 'planilha-dashboard' })).statusCode).toBe(404);
    expect((await req('PUT', `/clientes/${id}/servicos/planilha-dashboard/autonomia`, { nivel: 'N1', justificativa: 'x' })).statusCode).toBe(404);
  });

  it('decisão dupla → 409 na segunda', async () => {
    const { demandaId } = await novaDemanda();
    await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'submeter_escopo', agente: 'gestor' });
    const [ap] = (await req('GET', '/aprovacoes')).json();
    expect((await req('POST', `/aprovacoes/${ap.id}/decisao`, { decisao: 'recusar' })).statusCode).toBe(200);
    expect((await req('POST', `/aprovacoes/${ap.id}/decisao`, { decisao: 'aprovar' })).statusCode).toBe(409);
    expect((await req('POST', '/aprovacoes/11111111-1111-4111-8111-111111111111/decisao', { decisao: 'aprovar' })).statusCode).toBe(404);
  });

  it('ação de operador em /demandas/:id/acoes → 400; escalar exige motivo; agente cancelar → 403', async () => {
    const { demandaId } = await novaDemanda();
    for (const acao of ['aprovar', 'recusar', 'retomar']) {
      expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao, agente: 'gestor' })).statusCode).toBe(400);
    }
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'escalar', agente: 'gestor' })).statusCode).toBe(400);
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'escalar', agente: 'gestor', motivo: 'dúvida' })).statusCode).toBe(200);
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'cancelar', agente: 'gestor' })).statusCode).toBe(403);
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'producao_ok', agente: 'gestor' })).statusCode).toBe(409);
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'cancelar', agente: '' })).statusCode).toBe(400);
    expect((await req('POST', '/demandas/11111111-1111-4111-8111-111111111111/acoes', { acao: 'cancelar', agente: 'g' })).statusCode).toBe(404);
  });

  it('corpo inválido → 400 com nome do campo; GET /demandas?clienteId= vazio → 400', async () => {
    const r = await req('POST', '/clientes', { nome: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('nome');
    expect((await req('GET', '/demandas?clienteId=')).statusCode).toBe(400);
    expect((await req('GET', '/demandas?clienteId=abc')).statusCode).toBe(400);
    const longo = await req('POST', '/eventos', {
      canalTipo: 'email', canalIdentificador: 'a@b.c', idExterno: '1', texto: 'a'.repeat(20_001), recebidoEm: new Date().toISOString(),
    });
    expect(longo.statusCode).toBe(400);
    expect(longo.body).toContain('texto');
  });

  it('PUT autonomia: N3 via rota explícita, justificativa obrigatória', async () => {
    const id = await novoCliente();
    const url = `/clientes/${id}/servicos/planilha-dashboard/autonomia`;
    expect((await req('PUT', url, { nivel: 'N3', justificativa: '  ' })).statusCode).toBe(400);
    expect((await req('PUT', url, { nivel: 'N9', justificativa: 'x' })).statusCode).toBe(400);
    expect((await req('PUT', url, { nivel: 'N3', justificativa: 'confiança' })).statusCode).toBe(204);
    expect((await req('PUT', `/clientes/${id}/servicos/nao-existe/autonomia`, { nivel: 'N1', justificativa: 'x' })).statusCode).toBe(400);
  });

  it('POST /pausas global → ação de agente 423; DELETE /pausas encerra', async () => {
    const { demandaId } = await novaDemanda();
    const p = await req('POST', '/pausas', { escopo: 'global', motivo: 'emergência' });
    expect(p.statusCode).toBe(201);
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'submeter_escopo', agente: 'gestor' })).statusCode).toBe(423);
    expect((await req('POST', '/execucoes', { demandaId, agente: 'gestor', modelo: 'm', versaoPrompt: 'v1' })).statusCode).toBe(423);
    expect((await req('DELETE', `/pausas/${p.json().id}`)).statusCode).toBe(204);
    expect((await req('DELETE', `/pausas/${p.json().id}`)).statusCode).toBe(409);
    expect((await req('POST', `/demandas/${demandaId}/acoes`, { acao: 'submeter_escopo', agente: 'gestor' })).statusCode).toBe(200);
  });

  it('POST /politica/autorizar com clienteId de outro cliente → negar escopo_cliente', async () => {
    const { demandaId } = await novaDemanda();
    const ok = await req('POST', '/politica/autorizar', { demandaId, agente: 'gestor', ferramenta: 'ler_demanda', argumentos: { demandaId } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().decisao).toBe('permitir');
    const r = await req('POST', '/politica/autorizar', {
      demandaId, agente: 'gestor', ferramenta: 'ler_demanda', argumentos: { demandaId, clienteId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ decisao: 'negar', motivo: 'escopo_cliente' });
    expect((await req('POST', '/politica/autorizar', { demandaId: '11111111-1111-4111-8111-111111111111', agente: 'gestor', ferramenta: 'ler_demanda', argumentos: {} })).statusCode).toBe(404);
  });

  it('execuções: iniciar, consumo, fim, encerrada → 409, inexistente → 404', async () => {
    const { demandaId } = await novaDemanda();
    const e = await req('POST', '/execucoes', { demandaId, agente: 'gestor', modelo: 'm', versaoPrompt: 'v1' });
    expect(e.statusCode).toBe(201);
    const id = e.json().id;
    const c = await req('POST', `/execucoes/${id}/consumo`, { turnos: 1, tokens: 100 });
    expect(c.statusCode).toBe(200);
    expect(c.json().continuar).toBe(true);
    expect((await req('POST', `/execucoes/${id}/consumo`, { tokens: -5 })).statusCode).toBe(400);
    expect((await req('POST', `/execucoes/${id}/fim`, { status: 'concluida' })).statusCode).toBe(204);
    expect((await req('POST', `/execucoes/${id}/fim`, { status: 'concluida' })).statusCode).toBe(409);
    expect((await req('POST', `/execucoes/11111111-1111-4111-8111-111111111111/fim`, { status: 'falhou' })).statusCode).toBe(404);
    expect((await req('POST', '/execucoes', { demandaId: '11111111-1111-4111-8111-111111111111', agente: 'g', modelo: 'm', versaoPrompt: 'v' })).statusCode).toBe(404);
  });

  it('erro interno → 500 genérico sem vazar detalhes', async () => {
    const quebrado = construirApp({
      db: { select: () => { throw new Error('segredo-interno-xyz'); } } as unknown as Db,
      catalogo, classificador: new ClassificadorFake(), operadorToken: TOKEN, configPolitica,
    });
    const r = await quebrado.inject({ method: 'GET', url: '/clientes', headers: auth });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('segredo-interno-xyz');
  });

  it('corpo > 1 MB → 413', async () => {
    const r = await app.inject({ method: 'POST', url: '/clientes', headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ nome: 'a'.repeat(1_100_000) }) });
    expect(r.statusCode).toBe(413);
  });
});
