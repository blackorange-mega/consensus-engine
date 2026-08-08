/**
 * A deliberately tiny mustache-like renderer.
 *
 * Two hard rules, both in service of text fidelity:
 *   1. Values are interpolated RAW. No HTML escaping, no smart quotes, no
 *      whitespace normalisation, no markdown round-tripping. A payload is an
 *      opaque UTF-8 string from the moment the user types it.
 *   2. Interpolated values are never re-scanned for tags, so a model answer
 *      containing `{{...}}` cannot inject a template variable.
 *
 * Supported: {{var}}, {{#var}}block{{/var}} (truthy), {{^var}}block{{/var}}
 * (falsy). Nesting of sections is supported one level deep, which is all the
 * prompt templates need.
 */

export type TemplateScope = Record<string, string | boolean | number | null | undefined>;

const SECTION_RE = /\{\{([#^])([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VAR_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

function truthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

function renderSections(tpl: string, scope: TemplateScope): string {
  let prev: string;
  let out = tpl;
  // Repeat so that sections nested inside sections resolve too.
  let guard = 0;
  do {
    prev = out;
    out = out.replace(SECTION_RE, (_m, sigil: string, name: string, body: string) => {
      const on = truthy(scope[name]);
      const keep = sigil === '#' ? on : !on;
      return keep ? body : '';
    });
  } while (out !== prev && guard++ < 8);
  return out;
}

export function render(tpl: string, scope: TemplateScope): string {
  const withSections = renderSections(tpl, scope);
  // Single pass: interpolated content is never rescanned.
  return withSections.replace(VAR_RE, (match, name: string) => {
    const v = scope[name];
    if (v === undefined || v === null) return match;
    return String(v);
  });
}

/** Every {{var}} and {{#var}} referenced by a template, for the editor UI. */
export function templateVariables(tpl: string): string[] {
  const found = new Set<string>();
  for (const m of tpl.matchAll(/\{\{[#^/]?([A-Za-z0-9_]+)\}\}/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Assert a value survived interpolation byte-for-byte. Used by the fidelity
 * gate: the original user prompt must appear verbatim in every prompt built
 * from it, never paraphrased and never reflowed.
 */
export function assertVerbatim(haystack: string, needle: string, label: string): void {
  if (needle.length === 0) return;
  if (!haystack.includes(needle)) {
    throw new Error(
      `fidelity violation: ${label} was altered during prompt construction ` +
        `(${needle.length} chars expected verbatim)`,
    );
  }
}
