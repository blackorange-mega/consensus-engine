import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** packages/engine — templates and fixtures live here, next to the code. */
export const ENGINE_ROOT = resolve(here, '..');
export const TEMPLATE_DIR = join(ENGINE_ROOT, 'templates');
export const FIXTURE_DIR = join(ENGINE_ROOT, 'fixtures');
export const REPO_ROOT = resolve(ENGINE_ROOT, '..', '..');

/** Everything the app writes lives here. Local-first: nothing leaves the machine. */
export const DATA_DIR = resolve(process.env.CONSENSUS_DATA_DIR ?? join(REPO_ROOT, '.data'));

export const CONFIG = {
  host: process.env.CONSENSUS_HOST ?? '127.0.0.1',
  port: Number(process.env.CONSENSUS_PORT ?? 8787),
  dataDir: DATA_DIR,
  dbPath: join(DATA_DIR, 'consensus.sqlite'),
  seatsPath: join(DATA_DIR, 'seats.json'),
  settingsPath: join(DATA_DIR, 'settings.json'),
  templateOverrideDir: join(DATA_DIR, 'templates'),
  descriptorPackPath: process.env.CONSENSUS_DESCRIPTOR_PACK ?? join(DATA_DIR, 'descriptors.json'),
  relayTokenPath: join(DATA_DIR, 'relay-token'),
  /** Max concurrent model calls across the whole engine. */
  maxConcurrency: Number(process.env.CONSENSUS_CONCURRENCY ?? 8),
  /** Rolling window for per-seat daily budgets. */
  budgetWindowMs: 24 * 60 * 60 * 1000,
} as const;

export function ensureDataDir(): void {
  for (const dir of [DATA_DIR, CONFIG.templateOverrideDir, join(DATA_DIR, 'exports')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * The relay WebSocket is localhost-only and token-paired on first connect.
 * The token is generated once and stored with the data, never transmitted
 * anywhere except to the extension the user pairs by hand.
 */
export function relayToken(): string {
  ensureDataDir();
  if (existsSync(CONFIG.relayTokenPath)) {
    const existing = readFileSync(CONFIG.relayTokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(CONFIG.relayTokenPath, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export const ENGINE_VERSION = '0.1.0';
