import type { AdapterKind, SeatConfig, SiteDescriptor } from '@consensus/shared';

import { logger } from '../util/logger.js';
import { AnthropicAdapter } from './anthropic.js';
import { CdpAdapter } from './cdp.js';
import { CliAdapter, CLI_PRESETS, type CliOptions } from './cli.js';
import { DesktopAdapter } from './desktop.js';
import { FailoverAdapter } from './failover.js';
import { GoogleAdapter } from './google.js';
import { MockAdapter, type MockConfig } from './mock.js';
import { OllamaAdapter } from './ollama.js';
import { OpenAiCompatibleAdapter } from './openaiCompatible.js';
import { RelayAdapter, type RelayHub } from './relay.js';
import type { ModelAdapter } from './types.js';

const log = logger('adapters');

/** Read an option with a default, tolerating loosely-typed JSON config. */
function opt<T>(options: Record<string, unknown>, key: string, fallback: T): T {
  const v = options[key];
  return (v === undefined || v === null ? fallback : v) as T;
}

/** Environment indirection so API keys live in the environment, not in a config file. */
function resolveKey(options: Record<string, unknown>, envVar: string): string {
  const direct = opt(options, 'apiKey', '');
  if (direct) return direct;
  const named = opt(options, 'apiKeyEnv', envVar);
  return process.env[named] ?? '';
}

export interface RegistryDeps {
  relay?: RelayHub;
  /** Site descriptors, needed by transports that drive a page directly. */
  descriptorFor?: (provider: string) => SiteDescriptor | undefined;
  /** Ground truth for mock seats, used by the eval harness. */
  mockOracle?: MockConfig['oracle'];
}

/**
 * Build a seat, including its failover chain.
 *
 * A seat with `fallbacks` becomes a `FailoverAdapter` over [primary, ...rest].
 * A fallback that cannot be constructed is dropped with a warning rather than
 * failing the whole seat — a missing API key should not cost you the browser
 * transport that was working fine.
 */
export function buildAdapter(seat: SeatConfig, deps: RegistryDeps = {}): ModelAdapter {
  const primary = buildOne(seat, seat.adapter, seat.options ?? {}, deps);
  if (!seat.fallbacks?.length) return primary;

  const chain: ModelAdapter[] = [primary];
  for (const fallback of seat.fallbacks) {
    try {
      chain.push(buildOne(seat, fallback.adapter, fallback.options ?? {}, deps));
    } catch (err) {
      log.warn(
        `seat "${seat.id}": fallback transport "${fallback.adapter}" is unavailable and was skipped — ${String(err)}`,
      );
    }
  }

  if (chain.length === 1) return primary;
  log.info(`seat "${seat.id}" has a ${chain.map((a) => a.kind).join(' → ')} failover chain`);
  return new FailoverAdapter(seat.id, seat.displayName, chain);
}

function buildOne(
  seat: SeatConfig,
  adapter: AdapterKind,
  o: Record<string, unknown>,
  deps: RegistryDeps,
): ModelAdapter {
  seat = { ...seat, adapter };

  switch (adapter) {
    case 'mock':
      return new MockAdapter(seat.id, seat.displayName, {
        persona: opt(o, 'persona', 'truthful'),
        accuracy: opt(o, 'accuracy', 1),
        latencyMs: opt(o, 'latencyMs', 0),
        seed: opt(o, 'seed', 1),
        oracle: deps.mockOracle,
      });

    case 'cli': {
      const preset = opt<string>(o, 'preset', '');
      const base = (preset && CLI_PRESETS[preset]) || undefined;
      const options: CliOptions = {
        command: opt(o, 'command', base?.command ?? preset ?? 'claude'),
        args: opt(o, 'args', base?.args ?? []),
        stdin: opt(o, 'stdin', base?.stdin ?? true),
        cwd: opt(o, 'cwd', undefined as unknown as string),
        env: opt(o, 'env', undefined as unknown as Record<string, string>),
        stripAnsi: opt(o, 'stripAnsi', base?.stripAnsi ?? true),
        dropLinePattern: opt(o, 'dropLinePattern', undefined as unknown as string),
      };
      return new CliAdapter(seat.id, seat.displayName, options);
    }

    case 'ollama':
      return new OllamaAdapter(seat.id, seat.displayName, {
        baseUrl: opt(o, 'baseUrl', 'http://127.0.0.1:11434'),
        model: opt(o, 'model', 'llama3.1'),
        temperature: opt(o, 'temperature', 0),
        seed: opt(o, 'seed', 0),
        numCtx: opt(o, 'numCtx', undefined as unknown as number),
      });

    case 'lmstudio':
      return new OpenAiCompatibleAdapter(seat.id, seat.displayName, 'lmstudio', {
        baseUrl: opt(o, 'baseUrl', 'http://127.0.0.1:1234/v1'),
        model: opt(o, 'model', 'local-model'),
        temperature: opt(o, 'temperature', 0),
      });

    case 'openai':
      return new OpenAiCompatibleAdapter(seat.id, seat.displayName, 'openai', {
        baseUrl: opt(o, 'baseUrl', 'https://api.openai.com/v1'),
        model: opt(o, 'model', 'gpt-4o'),
        apiKey: resolveKey(o, 'OPENAI_API_KEY'),
        temperature: opt(o, 'temperature', 0),
        pricing: opt(o, 'pricing', undefined as unknown as { inPerM: number; outPerM: number }),
      });

    case 'openrouter':
      return new OpenAiCompatibleAdapter(seat.id, seat.displayName, 'openrouter', {
        baseUrl: opt(o, 'baseUrl', 'https://openrouter.ai/api/v1'),
        model: opt(o, 'model', 'openai/gpt-4o'),
        apiKey: resolveKey(o, 'OPENROUTER_API_KEY'),
        appName: 'Consensus Engine',
        temperature: opt(o, 'temperature', 0),
      });

    case 'anthropic':
      return new AnthropicAdapter(seat.id, seat.displayName, {
        apiKey: resolveKey(o, 'ANTHROPIC_API_KEY'),
        model: opt(o, 'model', 'claude-sonnet-4-5'),
        baseUrl: opt(o, 'baseUrl', undefined as unknown as string),
        maxTokens: opt(o, 'maxTokens', 8192),
        temperature: opt(o, 'temperature', 0),
        pricing: opt(o, 'pricing', undefined as unknown as { inPerM: number; outPerM: number }),
      });

    case 'google':
      return new GoogleAdapter(seat.id, seat.displayName, {
        apiKey: resolveKey(o, 'GOOGLE_API_KEY'),
        model: opt(o, 'model', 'gemini-2.0-flash'),
        temperature: opt(o, 'temperature', 0),
      });

    case 'relay': {
      if (!deps.relay) {
        throw new Error(`seat "${seat.id}" needs the browser relay, but no relay hub is running`);
      }
      return new RelayAdapter(seat.id, seat.displayName, deps.relay, {
        provider: opt(o, 'provider', seat.id),
        freshThreadPerCall: opt(o, 'freshThreadPerCall', true),
      });
    }

    case 'cdp': {
      const provider = opt(o, 'provider', seat.id);
      const descriptor = deps.descriptorFor?.(provider);
      if (!descriptor) {
        throw new Error(`seat "${seat.id}" needs a descriptor for provider "${provider}"`);
      }
      return new CdpAdapter(seat.id, seat.displayName, descriptor, {
        provider,
        port: opt(o, 'port', 9222),
        host: opt(o, 'host', '127.0.0.1'),
        launch: opt(o, 'launch', false),
        browserPath: opt(o, 'browserPath', undefined as unknown as string),
        profileDir: opt(o, 'profileDir', undefined as unknown as string),
        headless: opt(o, 'headless', false),
        freshThreadPerCall: opt(o, 'freshThreadPerCall', true),
      });
    }

    case 'desktop':
      return new DesktopAdapter(seat.id, seat.displayName, {
        app: opt(o, 'app', seat.displayName),
        driverCommand: opt(o, 'driverCommand', undefined as unknown as string),
        driverArgs: opt(o, 'driverArgs', [] as string[]),
        confirmFirstSend: opt(o, 'confirmFirstSend', true),
      });

    default: {
      const never: never = adapter;
      throw new Error(`unknown adapter kind: ${String(never)}`);
    }
  }
}

/**
 * Build every enabled seat. A seat that cannot be constructed is reported and
 * skipped rather than taking the panel down with it.
 */
export function buildPanel(
  seats: SeatConfig[],
  deps: RegistryDeps = {},
): { adapters: Map<string, ModelAdapter>; failures: Array<{ seatId: string; error: string }> } {
  const adapters = new Map<string, ModelAdapter>();
  const failures: Array<{ seatId: string; error: string }> = [];

  for (const seat of seats) {
    if (!seat.enabled) continue;
    try {
      adapters.set(seat.id, buildAdapter(seat, deps));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`seat "${seat.id}" could not be built: ${error}`);
      failures.push({ seatId: seat.id, error });
    }
  }

  return { adapters, failures };
}
