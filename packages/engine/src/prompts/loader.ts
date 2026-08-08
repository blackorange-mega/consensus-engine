import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PromptTemplate, Stubbornness } from '@consensus/shared';

import { CONFIG, TEMPLATE_DIR, ensureDataDir } from '../config.js';
import { render, templateVariables, type TemplateScope } from '../util/mustache.js';
import { logger } from '../util/logger.js';

const log = logger('templates');

/**
 * Every prompt this app sends is a file the user can read and edit — there are
 * no hard-coded prompt strings. Shipped defaults live in `packages/engine/templates`;
 * user edits are written to the data dir and shadow them, so an edit is never
 * lost to an app update and a broken edit can be reverted by deleting one file.
 */

interface LoadedTemplate {
  id: string;
  description: string;
  body: string;
  customised: boolean;
}

const FRONTMATTER_RE = /^<!--([\s\S]*?)-->\s*/;

function stripFrontmatter(raw: string): { description: string; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { description: '', body: raw };
  const block = m[1] ?? '';
  const descMatch = block.match(/description:\s*>?\s*([\s\S]*?)(?:\n[a-z_]+:|$)/i);
  const description = (descMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return { description, body: raw.slice(m[0].length) };
}

export class TemplateStore {
  private cache = new Map<string, LoadedTemplate>();

  constructor() {
    this.reload();
  }

  reload(): void {
    ensureDataDir();
    this.cache.clear();
    const files = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const id = file.replace(/\.md$/, '');
      const overridePath = join(CONFIG.templateOverrideDir, file);
      const customised = existsSync(overridePath);
      const raw = readFileSync(customised ? overridePath : join(TEMPLATE_DIR, file), 'utf8');
      const { description, body } = stripFrontmatter(raw);
      this.cache.set(id, { id, description, body, customised });
    }
    log.info(`loaded ${this.cache.size} prompt templates`, {
      customised: [...this.cache.values()].filter((t) => t.customised).map((t) => t.id),
    });
  }

  list(): PromptTemplate[] {
    return [...this.cache.values()].map((t) => ({
      id: t.id,
      description: t.description,
      body: t.body,
      customised: t.customised,
      variables: templateVariables(t.body),
    }));
  }

  raw(id: string): string {
    const t = this.cache.get(id);
    if (!t) throw new Error(`unknown prompt template: ${id}`);
    return t.body;
  }

  /** Render a template. Values are interpolated raw -- see util/mustache.ts. */
  render(id: string, scope: TemplateScope): string {
    return render(this.raw(id), scope).replace(/\n{3,}/g, '\n\n').trimStart();
  }

  /** Persist a user edit. Writing the shipped default back removes the override. */
  save(id: string, body: string): PromptTemplate {
    ensureDataDir();
    if (!this.cache.has(id)) throw new Error(`unknown prompt template: ${id}`);
    writeFileSync(join(CONFIG.templateOverrideDir, `${id}.md`), body, 'utf8');
    this.reload();
    const t = this.cache.get(id)!;
    return {
      id,
      description: t.description,
      body: t.body,
      customised: t.customised,
      variables: templateVariables(t.body),
    };
  }

  /**
   * The agreement-modulation clause for a stubbornness level.
   * Blocks are delimited by `--- level N ---` inside stubbornness.md so the
   * whole dial stays inspectable and editable as one file.
   */
  stubbornnessClause(level: Stubbornness): string {
    const body = this.raw('stubbornness');
    const parts = body.split(/^---\s*level\s+(\d)\s*---\s*$/m);
    // parts: [preamble, "0", block0, "1", block1, ...]
    for (let i = 1; i < parts.length; i += 2) {
      if (Number(parts[i]) === level) return (parts[i + 1] ?? '').trim();
    }
    log.warn(`no stubbornness block for level ${level}; falling back to level 2`);
    for (let i = 1; i < parts.length; i += 2) {
      if (Number(parts[i]) === 2) return (parts[i + 1] ?? '').trim();
    }
    return '';
  }

  /** Snapshot of every template used by a run, so the run stays replayable after edits. */
  snapshot(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of ids) {
      if (this.cache.has(id)) out[id] = this.raw(id);
    }
    return out;
  }
}

export const templates = new TemplateStore();
