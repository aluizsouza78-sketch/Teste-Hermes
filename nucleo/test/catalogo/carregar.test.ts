import { describe, it, expect } from 'vitest';
import { carregarCatalogo, ErroCatalogo, SERVICO_SOB_MEDIDA } from '../../src/catalogo/carregar.js';

describe('carregarCatalogo', () => {
  it('carrega os 3 serviços reais', async () => {
    const c = await carregarCatalogo('catalogo');
    expect(c.ids().sort()).toEqual(['planilha-dashboard', 'sob-medida', 'validacao-conciliacao']);
    expect(c.obter('validacao-conciliacao')?.testesQaExtras).toContain('acerto_conjunto_rotulado_min_98');
  });

  it('expõe a constante do serviço sob medida', async () => {
    expect(SERVICO_SOB_MEDIDA).toBe('sob-medida');
    const c = await carregarCatalogo('catalogo');
    expect(c.obter(SERVICO_SOB_MEDIDA)?.construtor).toBe('agente-dev');
  });

  it('converte snake_case do YAML para camelCase', async () => {
    const c = await carregarCatalogo('catalogo');
    expect(c.obter('planilha-dashboard')).toMatchObject({
      id: 'planilha-dashboard',
      construtor: 'agente-dados-bi',
      repoModelo: 'modelos/dashboard',
      publicacao: 'container-web',
      rotinasOperacao: ['atualizar_dados'],
    });
    expect(c.obter('planilha-dashboard')?.entradasEscopo).toHaveLength(3);
  });

  it('obter retorna undefined para id desconhecido e listar retorna todos', async () => {
    const c = await carregarCatalogo('catalogo');
    expect(c.obter('nao-existe')).toBeUndefined();
    expect(c.listar()).toHaveLength(3);
  });

  it('falha nomeando arquivo e campo quando falta construtor', async () => {
    await expect(carregarCatalogo('test/catalogo/fixtures/sem-construtor'))
      .rejects.toThrow(/sem-construtor\.yaml.*construtor/);
  });

  it('falha com id duplicado', async () => {
    await expect(carregarCatalogo('test/catalogo/fixtures/duplicado'))
      .rejects.toThrow(/id duplicado.*planilha-dashboard/);
  });

  it('falha se não existir o serviço sob-medida', async () => {
    await expect(carregarCatalogo('test/catalogo/fixtures/sem-sob-medida')).rejects.toThrow(/sob-medida/);
  });

  it('lança ErroCatalogo', async () => {
    await expect(carregarCatalogo('test/catalogo/fixtures/sem-sob-medida')).rejects.toBeInstanceOf(ErroCatalogo);
  });
});
