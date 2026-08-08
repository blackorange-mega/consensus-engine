import { useEffect, useState } from 'react';

import { api, type Template } from '../api.js';

/**
 * The prompt template library: every prompt sent to a model is visible and
 * editable by the user.
 *
 * Edits are written to the data directory and shadow the shipped defaults, so
 * an edit survives an app update and a bad edit can be reverted.
 */
export function TemplatesView() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  const load = () =>
    void api.templates().then((r) => {
      setTemplates(r.templates);
      setSelected((current) => current ?? r.templates[0]?.id ?? null);
    });

  useEffect(load, []);

  useEffect(() => {
    const t = templates.find((x) => x.id === selected);
    if (t) setDraft(t.body);
  }, [selected, templates]);

  const current = templates.find((t) => t.id === selected);

  const save = async () => {
    if (!selected) return;
    await api.saveTemplate(selected, draft);
    setSaved(selected);
    setTimeout(() => setSaved(null), 2000);
    load();
  };

  return (
    <div className="split">
      <section className="card">
        <div className="spread">
          <h2>{current?.id ?? 'Prompts'}</h2>
          <div className="row">
            {current?.customised && <span className="tag revised">edited</span>}
            {saved === selected && <span className="tag agreed">saved</span>}
            <button className="btn small primary" onClick={() => void save()} disabled={draft === current?.body}>
              Save
            </button>
          </div>
        </div>

        {current && (
          <>
            <p className="faint" style={{ marginTop: 0 }}>
              {current.description}
            </p>
            {current.variables.length > 0 && (
              <p className="faint mono" style={{ marginTop: 0 }}>
                Variables: {current.variables.map((v) => `{{${v}}}`).join('  ')}
              </p>
            )}
          </>
        )}

        <textarea
          className="mono"
          rows={26}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />

        <p className="faint" style={{ marginBottom: 0 }}>
          Values are interpolated raw — no escaping, no reflowing. The user prompt must appear verbatim in
          every cross-examination prompt, and prompt construction fails loudly if an edit breaks that.
        </p>
      </section>

      <aside className="card">
        <h2>Templates</h2>
        <div className="stack" style={{ gap: 2 }}>
          {templates.map((t) => (
            <button
              key={t.id}
              className="tab"
              style={{ textAlign: 'left', width: '100%' }}
              aria-selected={t.id === selected}
              onClick={() => setSelected(t.id)}
            >
              {t.id}
              {t.customised && <span className="tag revised" style={{ marginLeft: 6 }}>edited</span>}
            </button>
          ))}
        </div>
        <p className="faint" style={{ marginBottom: 0, marginTop: 12 }}>
          <strong>stubbornness</strong> is the agreement-modulation dial. Tuning it is what took a losing
          multi-agent-debate protocol to state of the art in the literature, so it is the first thing worth
          experimenting with.
        </p>
      </aside>
    </div>
  );
}
