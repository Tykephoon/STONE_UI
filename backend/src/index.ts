/**
 * Server bootstrap.
 */
import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDatabase, getDatabase } from './db/index.js';

async function main(): Promise<void> {
  const db = getDatabase();
  const app = await buildApp({ db });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      closeDatabase();
      process.exit(0);
    } catch (cause) {
      app.log.error({ err: cause }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    { origins: config.ALLOWED_ORIGINS, database: config.DATABASE_PATH },
    'stone api ready',
  );
}

main().catch((cause) => {
  console.error('Failed to start:', cause);
  process.exit(1);
});
