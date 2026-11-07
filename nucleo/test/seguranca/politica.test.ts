import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autorizar,
  carregarPermissoes,
  type ClasseAcao,
  type ConfigPolitica,
  type Decisao,
  type DefinicaoFerramenta,
  type NivelAutonomia,
} from '../../src/seguranca/politica.js';

const def = (nome: string, classe: ClasseAcao, permitidaEmN3 = false): DefinicaoFerramenta => ({
  nome,
  classe,
  argumentos: z.object({ clienteId: z.string().optional(), repo: z.string().optional() }),
  permitidaEmN3,
});

const cfg: ConfigPolitica = {
  ferramentas: new Map<string, DefinicaoFerramenta>(
    [
      def('ler_repo', 'leitura'),
      def('editar_arquivo', 'escrita_reversivel'),
      def('publicar', 'irreversivel_ou_externa', true),
      def('enviar_email', 'irreversivel_ou_externa', false),
      def('pagar', 'nunca_autonoma'),
    ].map((f) => [f.nome, f]),
  ),
  permissoes: { dev: ['ler_repo', 'editar_arquivo', 'publicar', 'enviar_email', 'pagar'], leitor: ['ler_repo'] },
};

const ctx = (nivel: NivelAutonomia, extra: Partial<{ agente: string; pausado: boolean }> = {}) => ({
  agente: 'dev',
  clienteId: 'A',
  nivel,
  pausado: false,
  ...extra,
});

describe('autorizar (tabela de regras)', () => {
  it.each<[string, ReturnType<typeof ctx>, string, unknown, Decisao]>([
    ['1 pausado', ctx('N3', { pausado: true }), 'ler_repo', {}, { decisao: 'negar', motivo: 'pausado' }],
    ['2 ferramenta desconhecida', ctx('N3'), 'rm_rf', {}, { decisao: 'negar', motivo: 'ferramenta_desconhecida' }],
    ['3 ferramenta não permitida', ctx('N3', { agente: 'leitor' }), 'editar_arquivo', {}, { decisao: 'negar', motivo: 'ferramenta_nao_permitida' }],
    ['3 agente sem permissões', ctx('N3', { agente: 'fantasma' }), 'ler_repo', {}, { decisao: 'negar', motivo: 'ferramenta_nao_permitida' }],
    ['4 argumentos inválidos', ctx('N3'), 'ler_repo', { repo: 42 }, { decisao: 'negar', motivo: 'argumentos_invalidos' }],
    ['4 argumentos não-objeto', ctx('N3'), 'ler_repo', 'x', { decisao: 'negar', motivo: 'argumentos_invalidos' }],
    ['5 escopo de cliente', ctx('N2'), 'ler_repo', { clienteId: 'B' }, { decisao: 'negar', motivo: 'escopo_cliente' }],
    ['6 nunca autônoma', ctx('N3'), 'pagar', {}, { decisao: 'exigir_aprovacao', motivo: 'nunca_autonoma' }],
    ['7 leitura N0', ctx('N0'), 'ler_repo', {}, { decisao: 'exigir_aprovacao', motivo: 'nivel_N0' }],
    ['7 leitura N1', ctx('N1'), 'ler_repo', { clienteId: 'A' }, { decisao: 'permitir', motivo: 'nivel_N1' }],
    ['7 leitura N3', ctx('N3'), 'ler_repo', {}, { decisao: 'permitir', motivo: 'nivel_N3' }],
    ['8 escrita N0', ctx('N0'), 'editar_arquivo', {}, { decisao: 'exigir_aprovacao', motivo: 'nivel_N0' }],
    ['8 escrita N1', ctx('N1'), 'editar_arquivo', {}, { decisao: 'exigir_aprovacao', motivo: 'nivel_N1' }],
    ['8 escrita N2', ctx('N2'), 'editar_arquivo', {}, { decisao: 'permitir', motivo: 'nivel_N2' }],
    ['8 escrita N3', ctx('N3'), 'editar_arquivo', {}, { decisao: 'permitir', motivo: 'nivel_N3' }],
    ['9 irreversível N2', ctx('N2'), 'publicar', {}, { decisao: 'exigir_aprovacao', motivo: 'nivel_N2' }],
    ['9 irreversível N3 permitida', ctx('N3'), 'publicar', {}, { decisao: 'permitir', motivo: 'nivel_N3' }],
    ['9 irreversível N3 não permitidaEmN3', ctx('N3'), 'enviar_email', {}, { decisao: 'exigir_aprovacao', motivo: 'nivel_N3' }],
  ])('%s', (_nome, c, ferramenta, argumentos, esperado) => {
    expect(autorizar(c, { ferramenta, argumentos }, cfg)).toEqual(esperado);
  });

  it('clienteId de outro cliente nos argumentos é negado mesmo em N3', () => {
    expect(
      autorizar({ agente: 'dev', clienteId: 'A', nivel: 'N3', pausado: false }, { ferramenta: 'ler_repo', argumentos: { clienteId: 'B' } }, cfg),
    ).toEqual({ decisao: 'negar', motivo: 'escopo_cliente' });
  });

  it('pausa vence qualquer nível', () => {
    expect(
      autorizar({ agente: 'dev', clienteId: 'A', nivel: 'N3', pausado: true }, { ferramenta: 'publicar', argumentos: {} }, cfg),
    ).toEqual({ decisao: 'negar', motivo: 'pausado' });
  });

  it('ferramenta herdada do protótipo não é tratada como existente', () => {
    expect(
      autorizar(ctx('N3'), { ferramenta: 'constructor', argumentos: {} }, { ...cfg, permissoes: { dev: ['constructor'] } }),
    ).toEqual({ decisao: 'negar', motivo: 'ferramenta_desconhecida' });
  });
});

describe('carregarPermissoes', () => {
  it('lê config/ferramentas.yaml do projeto', async () => {
    expect(await carregarPermissoes('config/ferramentas.yaml')).toEqual({ gestor: ['ler_demanda'] });
  });

  it('rejeita formato inválido', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perm-'));
    const arq = join(dir, 'f.yaml');
    await writeFile(arq, 'agentes:\n  gestor: ler_demanda\n');
    await expect(carregarPermissoes(arq)).rejects.toThrow();
  });
});
