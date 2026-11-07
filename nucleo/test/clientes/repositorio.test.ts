import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { criarDbTeste, type Db } from '../../src/db/cliente.js';
import { auditoria } from '../../src/db/schema.js';
import { carregarCatalogo } from '../../src/catalogo/carregar.js';
import {
  CanalJaVinculado,
  ServicoInexistente,
  contratarServico,
  criarCliente,
  listarClientes,
  resolverClientePorCanal,
  vincularCanal,
} from '../../src/clientes/repositorio.js';

describe('clientes e canais', () => {
  let db: Db;
  beforeEach(async () => {
    db = await criarDbTeste();
  });

  it('resolve cliente pelo grupo de WhatsApp', async () => {
    const c = await criarCliente(db, { nome: 'Fiori' }, 'operador');
    await vincularCanal(db, c.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    const r = await resolverClientePorCanal(db, 'whatsapp_grupo', 'g1');
    expect(r).toEqual({ id: c.id, nome: 'Fiori', servicosContratados: [] });
  });

  it('recusa canal já vinculado a outro cliente', async () => {
    const a = await criarCliente(db, { nome: 'A' }, 'operador');
    const b = await criarCliente(db, { nome: 'B' }, 'operador');
    await vincularCanal(db, a.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    const p = vincularCanal(db, b.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    await expect(p).rejects.toBeInstanceOf(CanalJaVinculado);
    await expect(p).rejects.toMatchObject({ clienteIdAtual: a.id });
  });

  it('vincular o mesmo canal ao mesmo cliente é idempotente', async () => {
    const a = await criarCliente(db, { nome: 'A' }, 'operador');
    await vincularCanal(db, a.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    await vincularCanal(db, a.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    const rs = await db.select().from(auditoria).where(eq(auditoria.acao, 'canal.vinculado'));
    expect(rs).toHaveLength(1);
  });

  it('corrida: vínculos concorrentes de clientes diferentes resultam em um só dono', async () => {
    const a = await criarCliente(db, { nome: 'A' }, 'operador');
    const b = await criarCliente(db, { nome: 'B' }, 'operador');
    const rs = await Promise.allSettled([
      vincularCanal(db, a.id, { tipo: 'email', identificador: 'x@y.com' }, 'operador'),
      vincularCanal(db, b.id, { tipo: 'email', identificador: 'x@y.com' }, 'operador'),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(CanalJaVinculado);
  });

  it('e-mail é resolvido sem diferenciar maiúsculas e espaços', async () => {
    const c = await criarCliente(db, { nome: 'Fiori' }, 'operador');
    await vincularCanal(db, c.id, { tipo: 'email', identificador: ' Financeiro@Fiori.com ' }, 'operador');
    const r = await resolverClientePorCanal(db, 'email', 'financeiro@fiori.com');
    expect(r?.id).toBe(c.id);
    expect((await resolverClientePorCanal(db, 'email', 'FINANCEIRO@fiori.com'))?.id).toBe(c.id);
  });

  it('canal desconhecido → null', async () => {
    expect(await resolverClientePorCanal(db, 'whatsapp_grupo', 'nada')).toBeNull();
  });

  it('contrata serviço do catálogo, lista em resolver; idempotente; recusa inexistente', async () => {
    const catalogo = await carregarCatalogo('catalogo');
    const c = await criarCliente(db, { nome: 'Fiori' }, 'operador');
    await vincularCanal(db, c.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    const id = catalogo.ids()[0];
    await contratarServico(db, c.id, id, { a: 1 }, catalogo, 'operador');
    await contratarServico(db, c.id, id, { a: 2 }, catalogo, 'operador');
    const r = await resolverClientePorCanal(db, 'whatsapp_grupo', 'g1');
    expect(r?.servicosContratados).toEqual([id]);
    await expect(contratarServico(db, c.id, 'nao-existe', {}, catalogo, 'operador')).rejects.toBeInstanceOf(
      ServicoInexistente,
    );
  });

  it('lista clientes', async () => {
    const c = await criarCliente(db, { nome: 'Fiori', contatos: [{ n: 1 }], cofreRef: 'cofre://f' }, 'operador');
    expect(await listarClientes(db)).toEqual([{ id: c.id, nome: 'Fiori', status: 'ativo' }]);
  });

  it('cada operação grava auditoria', async () => {
    const catalogo = await carregarCatalogo('catalogo');
    const c = await criarCliente(db, { nome: 'Fiori' }, 'operador');
    await vincularCanal(db, c.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador');
    await contratarServico(db, c.id, catalogo.ids()[0], {}, catalogo, 'operador');
    const acoes = (await db.select().from(auditoria)).map((a) => a.acao).sort();
    expect(acoes).toEqual(['canal.vinculado', 'cliente.criado', 'servico.contratado']);
  });
});
