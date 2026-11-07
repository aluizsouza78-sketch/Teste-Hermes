import { z } from 'zod';
import { criarDb } from './db/cliente.js';
import { carregarCatalogo } from './catalogo/carregar.js';
import { carregarPermissoes, type ConfigPolitica } from './seguranca/politica.js';
import type { Classificador } from './eventos/classificador.js';
import { construirApp } from './api/app.js';

/** Até o Plano 2: toda classificação falha e o evento cai em revisao_humana. */
class ClassificadorIndisponivel implements Classificador {
  async classificar(): Promise<never> {
    throw new Error('classificador indisponível (Plano 2)');
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL ausente');
  const operadorToken = process.env.OPERADOR_TOKEN;
  if (!operadorToken || operadorToken.length < 32) {
    throw new Error('OPERADOR_TOKEN ausente ou com menos de 32 caracteres');
  }
  const porta = Number(process.env.PORTA ?? 3000);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) throw new Error('PORTA inválida');

  const configPolitica: ConfigPolitica = {
    ferramentas: new Map([
      [
        'ler_demanda',
        { nome: 'ler_demanda', classe: 'leitura', argumentos: z.object({ demandaId: z.string().uuid() }), permitidaEmN3: false },
      ],
    ]),
    permissoes: await carregarPermissoes('config/ferramentas.yaml'),
  };

  const app = construirApp({
    db: criarDb(databaseUrl),
    catalogo: await carregarCatalogo('./catalogo'),
    classificador: new ClassificadorIndisponivel(),
    operadorToken,
    configPolitica,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Nunca registrar o token do operador.
      redact: ['req.headers.authorization'],
    },
  });
  await app.listen({ port: porta, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error(`Falha ao iniciar: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
