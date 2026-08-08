import { CONFIG, ENGINE_VERSION, ensureDataDir, relayToken } from './config.js';
import { Engine } from './engine.js';
import { startServer } from './server/http.js';
import { logger, setLogLevel } from './util/logger.js';

const log = logger('main');

async function main(): Promise<void> {
  if (process.env.LOG_LEVEL) setLogLevel(process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error');
  ensureDataDir();

  const engine = new Engine();
  const server = startServer(engine);

  const seats = engine.getSeats();
  if (seats.length === 0) {
    log.info('no seats configured yet — probing this machine for usable models');
    const { found, suggestion } = await engine.discover();
    log.info(`found ${found.length} candidate seat(s)`);
    for (const w of suggestion.warnings) log.warn(w);
    if (suggestion.seats.length) {
      engine.setSeats([...suggestion.seats, ...found.filter((f) => !suggestion.seats.some((s) => s.id === f.seat.id)).map((f) => f.seat)]);
      log.info(`enabled a starting panel: ${suggestion.seats.map((s) => s.displayName).join(', ')}`);
    } else {
      log.warn(
        'no models were found on this machine. Install a CLI (claude/gemini/codex), start Ollama, ' +
          'set an API key, or pair the browser relay extension.',
      );
    }
  }

  void engine.refreshHealth();

  log.info(`Consensus Engine ${ENGINE_VERSION}`);
  log.info(`  UI / API   http://${CONFIG.host}:${CONFIG.port}`);
  log.info(`  relay      ws://${CONFIG.host}:${CONFIG.port}/relay`);
  log.info(`  pair token ${relayToken().slice(0, 8)}… (full value: ${CONFIG.relayTokenPath})`);
  log.info(`  data       ${CONFIG.dataDir}`);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received; shutting down`);
    server.close();
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('engine failed to start:', err);
  process.exit(1);
});
