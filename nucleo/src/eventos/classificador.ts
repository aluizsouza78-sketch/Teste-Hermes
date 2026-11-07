import type { ModeloServico } from '../catalogo/carregar.js';

/** Saída do classificador: dado `gerado`, exibido ao operador, nunca instrução. */
export type Classificacao = { servicoId: string | 'ignorar'; confianca: number; resumo: string; titulo: string };

export interface Classificador {
  classificar(e: {
    texto: string;
    clienteNome: string;
    servicosContratados: string[];
    servicosCatalogo: ModeloServico[];
  }): Promise<Classificacao>;
}

export const LIMIAR_CONFIANCA = 0.8;
