import { describe, it, expect } from 'vitest';
import {
  transicionar,
  TransicaoInvalida,
  AtorNaoAutorizado,
  MAX_TENTATIVAS_QA,
  ACOES_DO_OPERADOR,
  type Etapa,
  type Acao,
  type Ator,
  type Resultado,
} from '../../src/esteira/maquina.js';

const operador: Ator = { tipo: 'operador' };
const agente: Ator = { tipo: 'agente', nome: 'construtor' };
const sistema: Ator = { tipo: 'agente', nome: 'sistema' };

const ETAPAS: Etapa[] = [
  'escopo', 'aguardando_aprovacao_escopo', 'construcao', 'qa', 'aguardando_aprovacao_entrega',
  'producao', 'operacao', 'escalada', 'cancelada',
];

type Linha = [Etapa, Acao, Ator, Resultado, number?, string?];

const linhas: Linha[] = [
  ['escopo', 'submeter_escopo', agente, { etapa: 'aguardando_aprovacao_escopo', tentativasQa: 0, abrirAprovacao: 'escopo' }],
  ['aguardando_aprovacao_escopo', 'aprovar', operador, { etapa: 'construcao', tentativasQa: 0 }],
  ['aguardando_aprovacao_escopo', 'recusar', operador, { etapa: 'escopo', tentativasQa: 0 }],
  ['construcao', 'concluir_construcao', agente, { etapa: 'qa', tentativasQa: 0 }],
  ['qa', 'qa_aprovado', agente, { etapa: 'aguardando_aprovacao_entrega', tentativasQa: 0, abrirAprovacao: 'entrega' }],
  ['qa', 'qa_reprovado', agente, { etapa: 'construcao', tentativasQa: 1 }],
  ['aguardando_aprovacao_entrega', 'aprovar', operador, { etapa: 'producao', tentativasQa: 0 }],
  ['aguardando_aprovacao_entrega', 'recusar', operador, { etapa: 'construcao', tentativasQa: 0 }],
  ['producao', 'producao_ok', agente, { etapa: 'operacao', tentativasQa: 0 }],
  ['producao', 'producao_falhou', agente, { etapa: 'escalada', tentativasQa: 0, abrirAprovacao: 'escalada', motivo: 'falha_producao_revertida' }],
  ['escalada', 'retomar', operador, { etapa: 'construcao', tentativasQa: 0 }],
];

describe('transicionar', () => {
  it.each(linhas)('%s + %s', (etapa, acao, ator, esperado) => {
    expect(transicionar({ etapa, tentativasQa: 0 }, acao, ator)).toEqual(esperado);
  });

  it('retomar zera tentativas', () => {
    expect(transicionar({ etapa: 'escalada', tentativasQa: 3 }, 'retomar', operador)).toEqual({ etapa: 'construcao', tentativasQa: 0 });
  });

  it('recusar entrega não conta tentativa de QA', () => {
    expect(transicionar({ etapa: 'aguardando_aprovacao_entrega', tentativasQa: 2 }, 'recusar', operador)).toEqual({ etapa: 'construcao', tentativasQa: 2 });
  });

  it.each(['escopo', 'construcao', 'qa', 'producao', 'operacao'] as Etapa[])('escalar de %s', (etapa) => {
    expect(transicionar({ etapa, tentativasQa: 1 }, 'escalar', agente, 'orcamento_estourado')).toEqual({
      etapa: 'escalada', tentativasQa: 1, abrirAprovacao: 'escalada', motivo: 'orcamento_estourado',
    });
    expect(transicionar({ etapa, tentativasQa: 1 }, 'escalar', sistema, 'x').etapa).toBe('escalada');
    expect(transicionar({ etapa, tentativasQa: 1 }, 'escalar', operador, 'x').etapa).toBe('escalada');
  });

  it('escalar sem motivo é inválido', () => {
    expect(() => transicionar({ etapa: 'construcao', tentativasQa: 0 }, 'escalar', agente)).toThrow(TransicaoInvalida);
    expect(() => transicionar({ etapa: 'construcao', tentativasQa: 0 }, 'escalar', agente, '')).toThrow(TransicaoInvalida);
  });

  it('escalar de etapas não escaláveis é inválido', () => {
    for (const etapa of ['aguardando_aprovacao_escopo', 'aguardando_aprovacao_entrega', 'escalada', 'cancelada'] as Etapa[]) {
      expect(() => transicionar({ etapa, tentativasQa: 0 }, 'escalar', agente, 'x')).toThrow(TransicaoInvalida);
    }
  });

  it.each(ETAPAS.filter((e) => e !== 'cancelada'))('cancelar de %s', (etapa) => {
    expect(transicionar({ etapa, tentativasQa: 2 }, 'cancelar', operador)).toEqual({ etapa: 'cancelada', tentativasQa: 2 });
  });

  it('agente não pode cancelar', () => {
    expect(() => transicionar({ etapa: 'construcao', tentativasQa: 0 }, 'cancelar', agente)).toThrow(AtorNaoAutorizado);
  });

  it('3ª reprovação no QA escala', () => {
    const r = transicionar({ etapa: 'qa', tentativasQa: 2 }, 'qa_reprovado', agente);
    expect(r).toEqual({ etapa: 'escalada', tentativasQa: 3, abrirAprovacao: 'escalada', motivo: 'limite_tentativas_qa' });
  });
  it('2ª reprovação volta para construção', () => {
    expect(transicionar({ etapa: 'qa', tentativasQa: 1 }, 'qa_reprovado', agente)).toEqual({ etapa: 'construcao', tentativasQa: 2 });
  });
  it('agente não pode aprovar', () => {
    expect(() => transicionar({ etapa: 'aguardando_aprovacao_entrega', tentativasQa: 0 }, 'aprovar', agente)).toThrow(AtorNaoAutorizado);
  });
  it('ator não autorizado vem antes da checagem de transição', () => {
    expect(() => transicionar({ etapa: 'escopo', tentativasQa: 0 }, 'aprovar', agente)).toThrow(AtorNaoAutorizado);
  });
  it('ação fora de hora é inválida', () => {
    expect(() => transicionar({ etapa: 'escopo', tentativasQa: 0 }, 'qa_aprovado', agente)).toThrow(TransicaoInvalida);
  });
  it('erros carregam etapa e ação', () => {
    try {
      transicionar({ etapa: 'escopo', tentativasQa: 0 }, 'qa_aprovado', agente);
    } catch (e) {
      expect(e).toBeInstanceOf(TransicaoInvalida);
      expect((e as TransicaoInvalida).etapa).toBe('escopo');
      expect((e as TransicaoInvalida).acao).toBe('qa_aprovado');
      expect((e as Error).message).toContain('qa_aprovado');
    }
  });
  it('operador pode executar ações de agente', () => {
    expect(transicionar({ etapa: 'construcao', tentativasQa: 0 }, 'concluir_construcao', operador).etapa).toBe('qa');
  });
  it('nada sai de cancelada', () => {
    for (const acao of ['retomar', 'cancelar', 'aprovar', 'recusar'] as Acao[]) {
      expect(() => transicionar({ etapa: 'cancelada', tentativasQa: 0 }, acao, operador)).toThrow(TransicaoInvalida);
    }
    expect(() => transicionar({ etapa: 'cancelada', tentativasQa: 0 }, 'escalar', agente, 'x')).toThrow(TransicaoInvalida);
  });
  it('constantes', () => {
    expect(MAX_TENTATIVAS_QA).toBe(3);
    expect([...ACOES_DO_OPERADOR].sort()).toEqual(['aprovar', 'cancelar', 'recusar', 'retomar']);
  });
});
