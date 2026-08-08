import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AdapterKind, DescriptorPack, SeatConfig } from '@consensus/shared';

import { logger } from '../util/logger.js';

const exec = promisify(execFile);
const log = logger('discovery');

/**
 * Auto-discovery on first run: probe for installed CLIs, a
 * running Ollama/LM Studio, installed desktop apps, the relay extension's
 * connection state, and any configured keys. Everything found is *proposed*,
 * never enabled behind the user's back — they pick the panel.
 */

export interface Discovered {
  seat: SeatConfig;
  detail: string;
  /** Free/unmetered seats are the ones worth spending extra rounds on. */
  unmetered: boolean;
}

async function commandExists(command: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await exec(probe, [command], { windowsHide: true, timeout: 5_000 });
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first?.trim() ?? null;
  } catch {
    return null;
  }
}

async function httpAlive(url: string, timeoutMs = 1_500): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

const CLI_SEATS: Array<{ id: string; name: string; preset: string }> = [
  { id: 'claude-cli', name: 'Claude (CLI)', preset: 'claude' },
  { id: 'gemini-cli', name: 'Gemini (CLI)', preset: 'gemini' },
  { id: 'codex-cli', name: 'Codex (CLI)', preset: 'codex' },
];

const API_SEATS: Array<{ id: string; name: string; adapter: AdapterKind; env: string; model: string }> = [
  { id: 'openai-api', name: 'OpenAI (API)', adapter: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-4o' },
  { id: 'anthropic-api', name: 'Anthropic (API)', adapter: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' },
  { id: 'google-api', name: 'Google (API)', adapter: 'google', env: 'GOOGLE_API_KEY', model: 'gemini-2.0-flash' },
  { id: 'openrouter-api', name: 'OpenRouter (API)', adapter: 'openrouter', env: 'OPENROUTER_API_KEY', model: 'openai/gpt-4o' },
];

/**
 * On-device LLM runtimes, all of which expose an OpenAI-shaped API on a
 * well-known localhost port.
 *
 * These matter more than their obscurity suggests: subscription quota is the
 * binding constraint on this whole app, and an unmetered local seat absorbing
 * the extra debate rounds is what turns "six runs before you are locked out"
 * into "as many as you like".
 */
const ON_DEVICE_RUNTIMES: Array<{ id: string; name: string; port: number; path: string; note: string }> = [
  { id: 'lmstudio', name: 'LM Studio', port: 1234, path: '/v1/models', note: 'LM Studio server is running' },
  { id: 'jan', name: 'Jan', port: 1337, path: '/v1/models', note: 'Jan is running' },
  { id: 'llamacpp', name: 'llama.cpp', port: 8080, path: '/v1/models', note: 'llama.cpp server is running' },
  { id: 'localai', name: 'LocalAI', port: 8081, path: '/v1/models', note: 'LocalAI is running' },
  { id: 'vllm', name: 'vLLM', port: 8000, path: '/v1/models', note: 'vLLM server is running' },
  { id: 'textgen', name: 'text-generation-webui', port: 5000, path: '/v1/models', note: 'text-generation-webui API is running' },
  { id: 'gpt4all', name: 'GPT4All', port: 4891, path: '/v1/models', note: 'GPT4All API server is running' },
  { id: 'koboldcpp', name: 'KoboldCpp', port: 5001, path: '/v1/models', note: 'KoboldCpp is running' },
];

/**
 * Browser-relay and CDP seats are proposed straight from the descriptor pack.
 *
 * A hardcoded list here would drift the moment the pack gained a provider —
 * which it already had: the pack shipped a working DeepSeek descriptor that
 * discovery never offered, so the seat existed but could only be reached by
 * hand-editing seats.json. Reading the pack also means a hot descriptor update
 * adds its providers to discovery without a new build.
 */
function relayProvidersFrom(pack: DescriptorPack | undefined): Array<{ provider: string; name: string }> {
  return (pack?.descriptors ?? []).map((d) => ({ provider: d.provider, name: d.displayName }));
}

function desktopAppPaths(): Array<{ id: string; name: string; app: string; paths: string[] }> {
  const home = homedir();
  if (process.platform === 'darwin') {
    return [
      { id: 'chatgpt-desktop', name: 'ChatGPT (desktop app)', app: 'ChatGPT', paths: ['/Applications/ChatGPT.app'] },
      { id: 'claude-desktop', name: 'Claude (desktop app)', app: 'Claude', paths: ['/Applications/Claude.app'] },
    ];
  }
  if (process.platform === 'win32') {
    const local = join(home, 'AppData', 'Local');
    return [
      {
        id: 'chatgpt-desktop',
        name: 'ChatGPT (desktop app)',
        app: 'ChatGPT',
        paths: [join(local, 'Programs', 'ChatGPT'), join(local, 'ChatGPT')],
      },
      {
        id: 'claude-desktop',
        name: 'Claude (desktop app)',
        app: 'Claude',
        paths: [join(local, 'Programs', 'claude'), join(local, 'AnthropicClaude')],
      },
    ];
  }
  return [];
}

export interface DiscoveryOptions {
  /** True when the relay extension is currently paired. */
  relayConnected: boolean;
  /** The live descriptor pack; every provider in it becomes an offerable seat. */
  pack?: DescriptorPack;
}

export async function discoverSeats(opts: DiscoveryOptions): Promise<Discovered[]> {
  const found: Discovered[] = [];
  const relayProviders = relayProvidersFrom(opts.pack);

  // --- CLI seats: deterministic, subscription-backed, no UI fragility -------
  await Promise.all(
    CLI_SEATS.map(async ({ id, name, preset }) => {
      const path = await commandExists(preset);
      if (!path) return;
      found.push({
        seat: {
          id,
          displayName: name,
          adapter: 'cli',
          enabled: true,
          options: { preset },
          budget: { perRun: 8, perDay: 120 },
        },
        detail: `found at ${path}`,
        unmetered: false,
      });
    }),
  );

  // --- Local models: free, offline, unlimited ------------------------------
  const ollama = (await httpAlive('http://127.0.0.1:11434/api/tags')) as
    | { models?: Array<{ name: string }> }
    | null;
  if (ollama?.models?.length) {
    for (const model of ollama.models.slice(0, 4)) {
      found.push({
        seat: {
          id: `ollama-${model.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
          displayName: `${model.name} (Ollama)`,
          adapter: 'ollama',
          enabled: false,
          options: { model: model.name, baseUrl: 'http://127.0.0.1:11434', temperature: 0 },
        },
        detail: 'local model, unmetered',
        unmetered: true,
      });
    }
  }

  // Every on-device runtime worth probing exposes an OpenAI-shaped endpoint on
  // a well-known localhost port. Probed in parallel; a closed port costs ~1.5s
  // at worst and nothing when the OS refuses immediately.
  await Promise.all(
    ON_DEVICE_RUNTIMES.map(async ({ id, name, port, path, note }) => {
      const res = (await httpAlive(`http://127.0.0.1:${port}${path}`)) as
        | { data?: Array<{ id: string }> }
        | null;
      const models = res?.data ?? [];
      if (!models.length) return;

      // Offer up to two models per runtime so a user with many local models
      // does not get a wall of seats.
      for (const model of models.slice(0, 2)) {
        found.push({
          seat: {
            id: `${id}-${model.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 60),
            displayName: `${model.id} (${name})`,
            adapter: 'lmstudio', // the OpenAI-compatible adapter serves them all
            enabled: false,
            options: {
              model: model.id,
              baseUrl: `http://127.0.0.1:${port}${path.replace(/\/models$/, '')}`,
              temperature: 0,
            },
          },
          detail: `${note}, unmetered`,
          unmetered: true,
        });
      }
    }),
  );

  // Chrome/Edge already listening on a debugging port: a CDP seat can attach to
  // the user's real logged-in session without the extension.
  for (const port of [9222, 9223]) {
    const version = (await httpAlive(`http://127.0.0.1:${port}/json/version`)) as
      | { Browser?: string }
      | null;
    if (!version?.Browser) continue;
    for (const { name, provider } of relayProviders) {
      found.push({
        seat: {
          id: `${provider}-cdp`,
          displayName: `${name} (CDP)`,
          adapter: 'cdp',
          enabled: false,
          options: { provider, port },
          budget: { perRun: 8, perDay: 40 },
        },
        detail: `${version.Browser} is listening on port ${port} — can attach directly`,
        unmetered: false,
      });
    }
    break; // one debugging endpoint is enough
  }

  // --- API seats: optional, key-gated --------------------------------------
  for (const { id, name, adapter, env, model } of API_SEATS) {
    if (!process.env[env]) continue;
    found.push({
      seat: {
        id,
        displayName: name,
        adapter,
        enabled: false,
        options: { apiKeyEnv: env, model, temperature: 0 },
      },
      detail: `${env} is set`,
      unmetered: false,
    });
  }

  // --- Browser relay seats -------------------------------------------------
  for (const { name, provider } of relayProviders) {
    found.push({
      seat: {
        id: `${provider}-web`,
        displayName: `${name} (browser)`,
        adapter: 'relay',
        enabled: false,
        options: { provider, freshThreadPerCall: true },
        budget: { perRun: 8, perDay: 40 },
      },
      detail: opts.relayConnected
        ? 'relay extension connected — enable to seat this subscription'
        : 'relay extension not connected; install and pair it to use this seat',
      unmetered: false,
    });
  }

  // --- Native desktop apps -------------------------------------------------
  for (const { id, name, app, paths } of desktopAppPaths()) {
    const hit = paths.find((p) => existsSync(p));
    if (!hit) continue;
    found.push({
      seat: {
        id,
        displayName: name,
        adapter: 'desktop',
        enabled: false,
        options: { app, confirmFirstSend: true },
        budget: { perRun: 8, perDay: 40 },
      },
      detail: `installed at ${hit} — needs an accessibility driver to be usable`,
      unmetered: false,
    });
  }

  log.info(`discovery found ${found.length} candidate seats`, found.map((f) => f.seat.id));
  return found;
}

/**
 * A sensible starting panel: prefer deterministic, cheap seats, and warn when
 * the panel is homogeneous. Zhang et al. found model heterogeneity is the
 * "universal antidote" that consistently improves multi-agent debate, and that
 * one base model in several personas is exactly the configuration that
 * underperforms — so a same-vendor panel is worth flagging.
 */
export function suggestPanel(found: Discovered[]): { seats: SeatConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const byFamily = new Map<string, Discovered[]>();
  for (const f of found) {
    const key = f.seat.adapter;
    byFamily.set(key, [...(byFamily.get(key) ?? []), f]);
  }

  const picked: SeatConfig[] = [];
  // Unmetered and subscription-backed first, then keys. OpenRouter is last of
  // the API options but must be here: it is the setup the bring-up guide
  // recommends, and leaving it out meant a user whose only key was
  // OPENROUTER_API_KEY got it discovered and then never proposed.
  for (const preferred of [
    'cli',
    'ollama',
    'lmstudio',
    'anthropic',
    'openai',
    'google',
    'openrouter',
  ] as AdapterKind[]) {
    for (const cand of byFamily.get(preferred) ?? []) {
      if (picked.length >= 4) break;
      picked.push({ ...cand.seat, enabled: true });
    }
  }

  if (picked.length < 2) {
    warnings.push(
      'fewer than two seats were discovered — the protocol needs at least two independent models to say anything',
    );
  }

  const vendors = new Set(
    picked.map((s) => s.id.replace(/-(cli|api|web|desktop)$/, '').split('-')[0]),
  );
  if (picked.length >= 2 && vendors.size < 2) {
    warnings.push(
      'every proposed seat comes from the same vendor — multi-agent debate underperforms on homogeneous panels; ' +
        'add a model from a different lab before trusting the result',
    );
  }

  if (picked[0]) picked[0].primary = true;
  return { seats: picked, warnings };
}
