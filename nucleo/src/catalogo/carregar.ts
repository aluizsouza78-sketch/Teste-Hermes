import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const SERVICO_SOB_MEDIDA = 'sob-medida';

export type ModeloServico = {
  id: string;
  nome: string;
  entradasEscopo: string[];
  construtor: 'agente-dados-bi' | 'agente-validacao' | 'agente-dev';
  repoModelo: string | null;
  testesQaExtras: string[];
  publicacao: 'container-web' | 'rotina' | 'definida-no-escopo';
  rotinasOperacao: string[];
};

export type Catalogo = {
  obter(id: string): ModeloServico | undefined;
  listar(): ModeloServico[];
  ids(): string[];
};

export class ErroCatalogo extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroCatalogo';
  }
}

const esquemaModelo = z.object({
  id: z.string().min(1),
  nome: z.string().min(1),
  entradas_escopo: z.array(z.string()),
  construtor: z.enum(['agente-dados-bi', 'agente-validacao', 'agente-dev']),
  repo_modelo: z.string().nullable(),
  testes_qa_extras: z.array(z.string()),
  publicacao: z.enum(['container-web', 'rotina', 'definida-no-escopo']),
  rotinas_operacao: z.array(z.string()),
});

function converter(m: z.infer<typeof esquemaModelo>): ModeloServico {
  return {
    id: m.id,
    nome: m.nome,
    entradasEscopo: m.entradas_escopo,
    construtor: m.construtor,
    repoModelo: m.repo_modelo,
    testesQaExtras: m.testes_qa_extras,
    publicacao: m.publicacao,
    rotinasOperacao: m.rotinas_operacao,
  };
}

export async function carregarCatalogo(diretorio: string): Promise<Catalogo> {
  const arquivos = (await readdir(diretorio)).filter((f) => f.endsWith('.yaml')).sort();
  const erros: string[] = [];
  const modelos: ModeloServico[] = [];

  for (const arquivo of arquivos) {
    let bruto: unknown;
    try {
      bruto = parse(await readFile(join(diretorio, arquivo), 'utf8'));
    } catch (e) {
      erros.push(`${arquivo}: YAML inválido: ${(e as Error).message}`);
      continue;
    }
    const resultado = esquemaModelo.safeParse(bruto);
    if (!resultado.success) {
      for (const issue of resultado.error.issues) {
        erros.push(`${arquivo}: campo "${issue.path.join('.')}" inválido: ${issue.message}`);
      }
      continue;
    }
    modelos.push(converter(resultado.data));
  }

  const vistos = new Set<string>();
  for (const m of modelos) {
    if (vistos.has(m.id)) erros.push(`id duplicado: ${m.id}`);
    vistos.add(m.id);
  }
  if (!vistos.has(SERVICO_SOB_MEDIDA)) {
    erros.push(`serviço obrigatório "${SERVICO_SOB_MEDIDA}" não encontrado`);
  }

  if (erros.length > 0) throw new ErroCatalogo(erros.join('\n'));

  const porId = new Map(modelos.map((m) => [m.id, m]));
  return {
    obter: (id) => porId.get(id),
    listar: () => [...modelos],
    ids: () => modelos.map((m) => m.id),
  };
}
