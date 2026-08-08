import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { DescriptorPack, RunSettings, SeatConfig } from '@consensus/shared';
import { DEFAULT_RUN_SETTINGS } from '@consensus/shared';

import { CONFIG, ensureDataDir } from './config.js';
import { DEFAULT_DESCRIPTOR_PACK } from './relay/defaultPack.js';
import { logger } from './util/logger.js';

const log = logger('config');

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    log.warn(`could not read ${path}; using defaults`, String(err));
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Seat and settings persistence.
 *
 * API keys are never written here — a seat stores the *name* of the environment
 * variable to read (`apiKeyEnv`), so the config file can be copied, exported or
 * shared without leaking credentials. Credentials stay where they already are;
 * the app does not collect them.
 */
export function loadSeats(): SeatConfig[] {
  return readJson<SeatConfig[]>(CONFIG.seatsPath, []);
}

export function saveSeats(seats: SeatConfig[]): SeatConfig[] {
  const cleaned = seats.map((s) => {
    const options = { ...s.options };
    if ('apiKey' in options) {
      delete options.apiKey;
      log.warn(`seat "${s.id}": a literal apiKey was dropped — use apiKeyEnv and keep the key in the environment`);
    }
    return { ...s, options };
  });
  writeJson(CONFIG.seatsPath, cleaned);
  return cleaned;
}

export function loadSettings(): RunSettings {
  return { ...DEFAULT_RUN_SETTINGS, ...readJson<Partial<RunSettings>>(CONFIG.settingsPath, {}) };
}

export function saveSettings(settings: Partial<RunSettings>): RunSettings {
  const merged = { ...loadSettings(), ...settings };
  writeJson(CONFIG.settingsPath, merged);
  return merged;
}

/**
 * The descriptor pack is versioned and hot-updatable without shipping a new
 * build — provider selectors break weekly and "wait for a release" is not an
 * acceptable repair path.
 */
export function loadDescriptorPack(): DescriptorPack {
  const pack = readJson<DescriptorPack | null>(CONFIG.descriptorPackPath, null);
  if (!pack) {
    writeJson(CONFIG.descriptorPackPath, DEFAULT_DESCRIPTOR_PACK);
    return DEFAULT_DESCRIPTOR_PACK;
  }
  return pack;
}

export function saveDescriptorPack(pack: DescriptorPack): DescriptorPack {
  writeJson(CONFIG.descriptorPackPath, pack);
  log.info(`descriptor pack updated to version ${pack.version}`);
  return pack;
}
