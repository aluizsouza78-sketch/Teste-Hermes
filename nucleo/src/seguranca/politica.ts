import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

/** Portão de Políticas: código determinístico e puro, sem LLM. */

export type NivelAutonomia = 'N0' | 'N1' | 'N2' | 'N3';
export type ClasseAcao = 'leitura' | 'escrita_reversivel' | 'irreversivel_ou_externa' | 'nunca_autonoma';
export type DefinicaoFerramenta = {
  nome: string;
  classe: ClasseAcao;
  argumentos: z.ZodTypeAny;
  permitidaEmN3: boolean;
};
export type ConfigPolitica = {
  ferramentas: Map<string, DefinicaoFerramenta>;
  /** agente → ferramentas permitidas */
  permissoes: Record<string, string[]>;
};
export type Decisao = { decisao: 'permitir' | 'negar' | 'exigir_aprovacao'; motivo: string };

export const NIVEIS: readonly NivelAutonomia[] = ['N0', 'N1', 'N2', 'N3'];

const negar = (motivo: string): Decisao => ({ decisao: 'negar', motivo });

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Verifica se os argumentos tentam mirar outro cliente. Olha o objeto bruto e o
 * resultado do schema: um schema que não declara `clienteId` (e o descarta) não
 * pode esconder a tentativa.
 */
function escopoViolado(bruto: unknown, validado: unknown, clienteId: string): boolean {
  for (const v of [bruto, validado]) {
    if (ehObjeto(v) && Object.hasOwn(v, 'clienteId') && v.clienteId !== undefined && v.clienteId !== clienteId) {
      return true;
    }
  }
  return false;
}

export function autorizar(
  ctx: { agente: string; clienteId: string; nivel: NivelAutonomia; pausado: boolean },
  chamada: { ferramenta: string; argumentos: unknown },
  config: ConfigPolitica,
): Decisao {
  // 1
  if (ctx.pausado) return negar('pausado');
  // 2
  const def = config.ferramentas.get(chamada.ferramenta);
  if (!def) return negar('ferramenta_desconhecida');
  // 3
  const permitidas = Object.hasOwn(config.permissoes, ctx.agente) ? config.permissoes[ctx.agente] : [];
  if (!permitidas.includes(chamada.ferramenta)) return negar('ferramenta_nao_permitida');
  // 4
  const validacao = def.argumentos.safeParse(chamada.argumentos);
  if (!validacao.success) return negar('argumentos_invalidos');
  // 5
  if (escopoViolado(chamada.argumentos, validacao.data, ctx.clienteId)) return negar('escopo_cliente');
  // 6
  if (def.classe === 'nunca_autonoma') return { decisao: 'exigir_aprovacao', motivo: 'nunca_autonoma' };

  const motivo = `nivel_${ctx.nivel}`;
  const indice = NIVEIS.indexOf(ctx.nivel);
  let permitir: boolean;
  switch (def.classe) {
    case 'leitura': // 7
      permitir = indice >= 1;
      break;
    case 'escrita_reversivel': // 8
      permitir = indice >= 2;
      break;
    case 'irreversivel_ou_externa': // 9
      permitir = ctx.nivel === 'N3' && def.permitidaEmN3;
      break;
  }
  return { decisao: permitir ? 'permitir' : 'exigir_aprovacao', motivo };
}

export class ErroPermissoes extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroPermissoes';
  }
}

const esquemaPermissoes = z.object({
  agentes: z.record(z.string().min(1), z.array(z.string().min(1))),
});

/** Lê `config/ferramentas.yaml` (`agentes: { <agente>: [<ferramenta>, ...] }`). */
export async function carregarPermissoes(caminhoYaml: string): Promise<Record<string, string[]>> {
  let bruto: unknown;
  try {
    bruto = parse(await readFile(caminhoYaml, 'utf8'));
  } catch (e) {
    throw new ErroPermissoes(`${caminhoYaml}: não foi possível ler: ${(e as Error).message}`);
  }
  const r = esquemaPermissoes.safeParse(bruto);
  if (!r.success) {
    const detalhes = r.error.issues.map((i) => `"${i.path.join('.')}": ${i.message}`).join('; ');
    throw new ErroPermissoes(`${caminhoYaml}: formato inválido: ${detalhes}`);
  }
  // Objeto sem protótipo: "constructor"/"__proto__" nunca viram agentes implícitos.
  return Object.assign(Object.create(null) as Record<string, string[]>, r.data.agentes);
}
