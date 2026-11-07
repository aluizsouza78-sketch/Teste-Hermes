import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { criarDbTeste, type Db } from '../../src/db/cliente.js';
import { auditoria, demandas, pausas } from '../../src/db/schema.js';
import { criarCliente } from '../../src/clientes/repositorio.js';
import { criarDemanda, executarAcao, obterDemanda } from '../../src/esteira/servico.js';
import type { Ator } from '../../src/esteira/maquina.js';
import { Pausado, encerrarPausa, estaPausado, pausar } from '../../src/seguranca/pausas.js';

const agente: Ator = { tipo: 'agente', nome: 'construtor' };
const operador: Ator = { tipo: 'operador' };

describe('pausa de emergência', () => {
  let db: Db;
  let clienteA: string;
  let clienteB: string;
  beforeEach(async () => {
    db = await criarDbTeste();
    clienteA = (await criarCliente(db, { nome: 'A' }, 'operador')).id;
    clienteB = (await criarCliente(db, { nome: 'B' }, 'operador')).id;
  });
  const nova = (clienteId: string) => criarDemanda(db, { clienteId, servicoId: 'sob-medida', titulo: 'T' }, operador);

  it('pausa global bloqueia executarAcao de agente com Pausado, mas operador ainda cancela', async () => {
    const d = await nova(clienteA);
    await pausar(db, { escopo: 'global', motivo: 'incidente' });
    await expect(executarAcao(db, d.id, 'submeter_escopo', agente)).rejects.toBeInstanceOf(Pausado);
    expect((await obterDemanda(db, d.id)).etapa).toBe('escopo');
    const estado = await executarAcao(db, d.id, 'cancelar', operador, 'parar tudo');
    expect(estado.etapa).toBe('cancelada');
  });

  it('pausa por cliente não afeta outro cliente', async () => {
    const dA = await nova(clienteA);
    const dB = await nova(clienteB);
    await pausar(db, { escopo: 'cliente', alvo: clienteA, motivo: 'vazamento' });
    expect(await estaPausado(db, { clienteId: clienteA, agente: 'construtor' })).toBe(true);
    expect(await estaPausado(db, { clienteId: clienteB, agente: 'construtor' })).toBe(false);
    await expect(executarAcao(db, dA.id, 'submeter_escopo', agente)).rejects.toBeInstanceOf(Pausado);
    expect((await executarAcao(db, dB.id, 'submeter_escopo', agente)).etapa).toBe('aguardando_aprovacao_escopo');
  });

  it('pausa bloqueia criarDemanda de agente, mas não do operador', async () => {
    await pausar(db, { escopo: 'cliente', alvo: clienteA, motivo: 'incidente' });
    const p = { clienteId: clienteA, servicoId: 'sob-medida', titulo: 'T' };
    await expect(criarDemanda(db, p, agente)).rejects.toBeInstanceOf(Pausado);
    expect(await db.select().from(demandas)).toHaveLength(0);
    await expect(criarDemanda(db, p, operador)).resolves.toHaveProperty('id');
    await expect(criarDemanda(db, { ...p, clienteId: clienteB }, agente)).resolves.toHaveProperty('id');
  });

  it('pausa por agente afeta só aquele agente', async () => {
    await pausar(db, { escopo: 'agente', alvo: 'construtor', motivo: 'loop' });
    expect(await estaPausado(db, { clienteId: clienteA, agente: 'construtor' })).toBe(true);
    expect(await estaPausado(db, { clienteId: clienteA, agente: 'qa' })).toBe(false);
  });

  it('encerrarPausa libera de novo', async () => {
    const d = await nova(clienteA);
    const p = await pausar(db, { escopo: 'global', motivo: 'incidente' });
    await expect(executarAcao(db, d.id, 'submeter_escopo', agente)).rejects.toBeInstanceOf(Pausado);
    await encerrarPausa(db, p.id);
    expect(await estaPausado(db, { clienteId: clienteA, agente: 'construtor' })).toBe(false);
    expect((await executarAcao(db, d.id, 'submeter_escopo', agente)).etapa).toBe('aguardando_aprovacao_escopo');
    const [linha] = await db.select().from(pausas).where(eq(pausas.id, p.id));
    expect(linha.encerradaEm).not.toBeNull();
    const acoes = (await db.select().from(auditoria)).map((a) => a.acao);
    expect(acoes).toContain('pausa.criada');
    expect(acoes).toContain('pausa.encerrada');
  });

  it('encerrar pausa já encerrada ou inexistente falha com erro claro', async () => {
    const p = await pausar(db, { escopo: 'global', motivo: 'x' });
    await encerrarPausa(db, p.id);
    await expect(encerrarPausa(db, p.id)).rejects.toThrow(/já encerrada/);
    await expect(encerrarPausa(db, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/não encontrada/);
  });

  it('pausa por cliente/agente exige alvo; global não aceita alvo', async () => {
    await expect(pausar(db, { escopo: 'cliente', motivo: 'x' })).rejects.toThrow(/alvo/);
    await expect(pausar(db, { escopo: 'global', alvo: clienteA, motivo: 'x' })).rejects.toThrow(/alvo/);
  });
});
