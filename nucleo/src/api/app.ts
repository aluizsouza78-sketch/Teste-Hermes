import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { Db } from '../db/cliente.js';
import { auditoria, clientes } from '../db/schema.js';
import type { Catalogo } from '../catalogo/carregar.js';
import type { Classificador } from '../eventos/classificador.js';
import type { ConfigPolitica } from '../seguranca/politica.js';
import { NIVEIS } from '../seguranca/politica.js';
import {
  CanalJaVinculado,
  ServicoInexistente,
  contratarServico,
  criarCliente,
  listarClientes,
  vincularCanal,
} from '../clientes/repositorio.js';
import { ingerirEvento } from '../eventos/ingestao.js';
import {
  AprovacaoJaDecidida,
  AprovacaoNaoEncontrada,
  DemandaNaoEncontrada,
  decidirAprovacao,
  executarAcao,
  listarAprovacoesPendentes,
  listarDemandas,
  obterDemanda,
} from '../esteira/servico.js';
import { AtorNaoAutorizado, TransicaoInvalida } from '../esteira/maquina.js';
import { autorizarChamada, definirAutonomia } from '../seguranca/portao.js';
import { Pausado, PausaJaEncerrada, PausaNaoEncontrada, encerrarPausa, pausar } from '../seguranca/pausas.js';
import {
  ExecucaoEncerrada,
  ExecucaoNaoEncontrada,
  OrcamentoEsgotado,
  finalizarExecucao,
  iniciarExecucao,
  registrarConsumo,
} from '../seguranca/orcamento.js';

export type DepsApi = {
  db: Db;
  catalogo: Catalogo;
  classificador: Classificador;
  operadorToken: string;
  configPolitica: ConfigPolitica;
};

const LIMITE_CORPO = 1_048_576;
const MAX_TEXTO = 20_000;
const OPERADOR = 'operador';

class ClienteNaoEncontrado extends Error {
  constructor(readonly clienteId: string) {
    super(`Cliente não encontrado: ${clienteId}`);
    this.name = 'ClienteNaoEncontrado';
  }
}

// guid aceita qualquer UUID em forma canônica; id inexistente vira 404, não 400.
const id = z.guid();
const textoNaoVazio = z.string().trim().min(1);
const tipoCanal = z.enum(['whatsapp_grupo', 'whatsapp_contato', 'email']);

const esquemas = {
  idParam: z.object({ id }),
  cliente: z.object({ nome: textoNaoVazio, contatos: z.array(z.unknown()).optional(), cofreRef: z.string().optional() }),
  canal: z.object({ tipo: tipoCanal, identificador: textoNaoVazio }),
  servico: z.object({ servicoId: textoNaoVazio, configuracao: z.record(z.string(), z.unknown()).optional() }),
  evento: z.object({
    canalTipo: tipoCanal,
    canalIdentificador: textoNaoVazio,
    idExterno: textoNaoVazio,
    texto: z.string().max(MAX_TEXTO),
    recebidoEm: z.iso.datetime({ offset: true }),
  }),
  demandasQuery: z.object({ clienteId: id.optional() }),
  acao: z.object({
    acao: z.enum([
      'submeter_escopo', 'concluir_construcao', 'qa_aprovado', 'qa_reprovado',
      'producao_ok', 'producao_falhou', 'escalar', 'cancelar',
    ]),
    agente: textoNaoVazio,
    motivo: textoNaoVazio.optional(),
  }),
  decisao: z.object({ decisao: z.enum(['aprovar', 'recusar']), comentario: z.string().optional() }),
  auditoriaQuery: z.object({
    alvoId: id.optional(),
    limite: z.coerce.number().int().min(1).default(100).transform((n) => Math.min(n, 500)),
  }),
  autonomiaParams: z.object({ id, servicoId: textoNaoVazio }),
  autonomia: z.object({ nivel: z.enum(NIVEIS as [string, ...string[]]), justificativa: textoNaoVazio }),
  autorizar: z.object({ demandaId: id, agente: textoNaoVazio, ferramenta: textoNaoVazio, argumentos: z.unknown() }),
  pausa: z
    .object({
      escopo: z.enum(['global', 'cliente', 'agente']),
      alvo: z.string().trim().optional(),
      motivo: textoNaoVazio,
    })
    .superRefine((p, ctx) => {
      const tem = p.alvo !== undefined && p.alvo !== '';
      if (p.escopo === 'global' && tem) ctx.addIssue({ code: 'custom', path: ['alvo'], message: 'Pausa global não aceita alvo' });
      if (p.escopo !== 'global' && !tem) ctx.addIssue({ code: 'custom', path: ['alvo'], message: `Pausa por ${p.escopo} exige alvo` });
    }),
  execucao: z.object({ demandaId: id, agente: textoNaoVazio, modelo: textoNaoVazio, versaoPrompt: textoNaoVazio }),
  consumo: z.object({
    turnos: z.number().int().min(0).optional(),
    chamadasFerramenta: z.number().int().min(0).optional(),
    tokens: z.number().int().min(0).optional(),
    custoCentavos: z.number().int().min(0).optional(),
    passo: z.record(z.string(), z.unknown()).optional(),
  }),
  fim: z.object({ status: z.enum(['concluida', 'falhou']) }),
};

function mesmoToken(recebido: string, esperado: string): boolean {
  // Hash de tamanho fixo: timingSafeEqual não lança nem vaza o tamanho do token.
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

function statusDoErro(err: unknown): { status: number; erro: string } | null {
  if (err instanceof ServicoInexistente) return { status: 400, erro: err.message };
  if (err instanceof AtorNaoAutorizado) return { status: 403, erro: err.message };
  if (
    err instanceof DemandaNaoEncontrada || err instanceof AprovacaoNaoEncontrada ||
    err instanceof ExecucaoNaoEncontrada || err instanceof ClienteNaoEncontrado ||
    err instanceof PausaNaoEncontrada
  ) return { status: 404, erro: err.message };
  if (
    err instanceof CanalJaVinculado || err instanceof TransicaoInvalida || err instanceof AprovacaoJaDecidida ||
    err instanceof ExecucaoEncerrada || err instanceof PausaJaEncerrada
  ) return { status: 409, erro: err.message };
  if (err instanceof Pausado || err instanceof OrcamentoEsgotado) return { status: 423, erro: err.message };
  return null;
}

export function construirApp(deps: DepsApi): FastifyInstance {
  const { db, catalogo, classificador, operadorToken, configPolitica } = deps;
  const app = Fastify({ bodyLimit: LIMITE_CORPO });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        erro: 'Requisição inválida',
        campos: err.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })),
      });
    }
    const mapeado = statusDoErro(err);
    if (mapeado) return reply.status(mapeado.status).send({ erro: mapeado.erro });
    // Erros do próprio Fastify (JSON malformado, corpo grande demais, tipo de mídia): 4xx seguros.
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ erro: status === 413 ? 'Corpo grande demais' : 'Requisição inválida' });
    }
    app.log.error(err);
    return reply.status(500).send({ erro: 'Erro interno' });
  });

  // Fora do plugin autenticado: /saude não passa por auth nem toca no banco.
  app.get('/saude', async () => ({ ok: true }));

  const exigirToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer (.+)$/.exec(h) : null;
    if (!m || !mesmoToken(m[1], operadorToken)) {
      return reply.status(401).send({ erro: 'Não autorizado' });
    }
  };

  const garantirCliente = async (clienteId: string) => {
    const [c] = await db.select({ id: clientes.id }).from(clientes).where(eq(clientes.id, clienteId));
    if (!c) throw new ClienteNaoEncontrado(clienteId);
  };

  app.register(async (r) => {
    r.addHook('onRequest', exigirToken);

    r.post('/clientes', async (req, reply) => {
      const b = esquemas.cliente.parse(req.body);
      const c = await criarCliente(db, b, OPERADOR);
      return reply.status(201).send(c);
    });
    r.get('/clientes', async () => listarClientes(db));

    r.post('/clientes/:id/canais', async (req, reply) => {
      const { id: clienteId } = esquemas.idParam.parse(req.params);
      const b = esquemas.canal.parse(req.body);
      await garantirCliente(clienteId);
      await vincularCanal(db, clienteId, b, OPERADOR);
      return reply.status(204).send();
    });

    r.post('/clientes/:id/servicos', async (req, reply) => {
      const { id: clienteId } = esquemas.idParam.parse(req.params);
      const b = esquemas.servico.parse(req.body);
      await garantirCliente(clienteId);
      await contratarServico(db, clienteId, b.servicoId, b.configuracao ?? {}, catalogo, OPERADOR);
      return reply.status(204).send();
    });

    r.get('/catalogo', async () => catalogo.listar());

    r.post('/eventos', async (req) => {
      const b = esquemas.evento.parse(req.body);
      return ingerirEvento(db, { classificador, catalogo }, { ...b, recebidoEm: new Date(b.recebidoEm) });
    });

    r.get('/demandas', async (req) => {
      const q = esquemas.demandasQuery.parse(req.query);
      return listarDemandas(db, q.clienteId === undefined ? {} : { clienteId: q.clienteId });
    });

    r.post('/demandas/:id/acoes', async (req) => {
      const { id: demandaId } = esquemas.idParam.parse(req.params);
      const b = esquemas.acao.parse(req.body);
      if (b.acao === 'escalar' && b.motivo === undefined) {
        throw new ZodError([{ code: 'custom', path: ['motivo'], message: 'motivo é obrigatório para escalar', input: undefined }]);
      }
      return executarAcao(db, demandaId, b.acao, { tipo: 'agente', nome: b.agente }, b.motivo);
    });

    r.get('/aprovacoes', async () => listarAprovacoesPendentes(db));

    r.post('/aprovacoes/:id/decisao', async (req) => {
      const { id: aprovacaoId } = esquemas.idParam.parse(req.params);
      const b = esquemas.decisao.parse(req.body);
      return decidirAprovacao(db, aprovacaoId, b.decisao, b.comentario ?? null);
    });

    r.get('/auditoria', async (req) => {
      const q = esquemas.auditoriaQuery.parse(req.query);
      const base = db.select().from(auditoria);
      const filtrada = q.alvoId === undefined ? base : base.where(eq(auditoria.alvoId, q.alvoId));
      return filtrada.orderBy(desc(auditoria.criadoEm), desc(auditoria.id)).limit(q.limite);
    });

    r.put('/clientes/:id/servicos/:servicoId/autonomia', async (req, reply) => {
      const p = esquemas.autonomiaParams.parse(req.params);
      const b = esquemas.autonomia.parse(req.body);
      await garantirCliente(p.id);
      await definirAutonomia(db, catalogo, p.id, p.servicoId, b.nivel as (typeof NIVEIS)[number], OPERADOR, b.justificativa);
      return reply.status(204).send();
    });

    r.post('/politica/autorizar', async (req) => {
      const b = esquemas.autorizar.parse(req.body);
      return autorizarChamada(db, configPolitica, b);
    });

    r.post('/pausas', async (req, reply) => {
      const b = esquemas.pausa.parse(req.body);
      const p = await pausar(db, { escopo: b.escopo, ...(b.alvo ? { alvo: b.alvo } : {}), motivo: b.motivo });
      return reply.status(201).send(p);
    });

    r.delete('/pausas/:id', async (req, reply) => {
      const { id: pausaId } = esquemas.idParam.parse(req.params);
      await encerrarPausa(db, pausaId);
      return reply.status(204).send();
    });

    r.post('/execucoes', async (req, reply) => {
      const b = esquemas.execucao.parse(req.body);
      await obterDemanda(db, b.demandaId); // 404 em vez de erro genérico
      const e = await iniciarExecucao(db, b);
      return reply.status(201).send(e);
    });

    r.post('/execucoes/:id/consumo', async (req) => {
      const { id: execucaoId } = esquemas.idParam.parse(req.params);
      const b = esquemas.consumo.parse(req.body);
      return registrarConsumo(db, execucaoId, b);
    });

    r.post('/execucoes/:id/fim', async (req, reply) => {
      const { id: execucaoId } = esquemas.idParam.parse(req.params);
      const b = esquemas.fim.parse(req.body);
      await finalizarExecucao(db, execucaoId, b.status);
      return reply.status(204).send();
    });
  });

  return app;
}
