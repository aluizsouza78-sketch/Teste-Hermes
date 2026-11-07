export type Etapa =
  | 'escopo' | 'aguardando_aprovacao_escopo' | 'construcao' | 'qa'
  | 'aguardando_aprovacao_entrega' | 'producao' | 'operacao' | 'escalada' | 'cancelada';

export type Acao =
  | 'submeter_escopo' | 'aprovar' | 'recusar' | 'concluir_construcao' | 'qa_aprovado'
  | 'qa_reprovado' | 'producao_ok' | 'producao_falhou' | 'escalar' | 'retomar' | 'cancelar';

export type Ator = { tipo: 'operador' } | { tipo: 'agente'; nome: string };
export type EstadoDemanda = { etapa: Etapa; tentativasQa: number };
export type Resultado = EstadoDemanda & {
  abrirAprovacao?: 'escopo' | 'entrega' | 'escalada';
  motivo?: string;
};

export const MAX_TENTATIVAS_QA = 3;
export const ACOES_DO_OPERADOR: ReadonlySet<Acao> = new Set<Acao>(['aprovar', 'recusar', 'retomar', 'cancelar']);

export class TransicaoInvalida extends Error {
  constructor(readonly etapa: Etapa, readonly acao: Acao, detalhe?: string) {
    super(`Transição inválida: ação '${acao}' na etapa '${etapa}'${detalhe ? ` (${detalhe})` : ''}`);
    this.name = 'TransicaoInvalida';
  }
}

export class AtorNaoAutorizado extends Error {
  constructor(readonly etapa: Etapa, readonly acao: Acao) {
    super(`Ator não autorizado: somente o operador pode '${acao}' (etapa '${etapa}')`);
    this.name = 'AtorNaoAutorizado';
  }
}

type Regra = (estado: EstadoDemanda, motivo?: string) => Resultado;

const simples = (etapa: Etapa): Regra => (e) => ({ etapa, tentativasQa: e.tentativasQa });
const abrindo = (etapa: Etapa, abrirAprovacao: 'escopo' | 'entrega'): Regra => (e) => ({
  etapa, tentativasQa: e.tentativasQa, abrirAprovacao,
});
const escalando = (motivoFixo?: string): Regra => (e, motivo) => ({
  etapa: 'escalada', tentativasQa: e.tentativasQa, abrirAprovacao: 'escalada', motivo: motivoFixo ?? (motivo as string),
});

const TABELA: Partial<Record<Etapa, Partial<Record<Acao, Regra>>>> = {
  escopo: { submeter_escopo: abrindo('aguardando_aprovacao_escopo', 'escopo'), escalar: escalando() },
  aguardando_aprovacao_escopo: { aprovar: simples('construcao'), recusar: simples('escopo') },
  construcao: { concluir_construcao: simples('qa'), escalar: escalando() },
  qa: {
    qa_aprovado: abrindo('aguardando_aprovacao_entrega', 'entrega'),
    qa_reprovado: (e) => {
      const tentativas = e.tentativasQa + 1;
      return tentativas >= MAX_TENTATIVAS_QA
        ? { etapa: 'escalada', tentativasQa: tentativas, abrirAprovacao: 'escalada', motivo: 'limite_tentativas_qa' }
        : { etapa: 'construcao', tentativasQa: tentativas };
    },
    escalar: escalando(),
  },
  aguardando_aprovacao_entrega: { aprovar: simples('producao'), recusar: simples('construcao') },
  producao: {
    producao_ok: simples('operacao'),
    producao_falhou: escalando('falha_producao_revertida'),
    escalar: escalando(),
  },
  operacao: { escalar: escalando() },
  escalada: { retomar: () => ({ etapa: 'construcao', tentativasQa: 0 }) },
};

export function transicionar(estado: EstadoDemanda, acao: Acao, ator: Ator, motivo?: string): Resultado {
  if (ACOES_DO_OPERADOR.has(acao) && ator.tipo !== 'operador') {
    throw new AtorNaoAutorizado(estado.etapa, acao);
  }
  const regra =
    acao === 'cancelar' && estado.etapa !== 'cancelada'
      ? simples('cancelada')
      : TABELA[estado.etapa]?.[acao];
  if (!regra) throw new TransicaoInvalida(estado.etapa, acao);
  if (acao === 'escalar' && !motivo) throw new TransicaoInvalida(estado.etapa, acao, 'motivo obrigatório');
  return regra(estado, motivo);
}
