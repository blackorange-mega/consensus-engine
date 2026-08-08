# Consensus Engine

A local-first desktop app where you write one prompt, it is dispatched **in parallel** to every LLM
reachable from your machine, and if the answers disagree the models are put through an **iterative
cross-examination loop** until they converge — or until the app reports an honest, unresolved
disagreement.

It is not a chat app with a model switcher. Its centre of gravity is the **divergence view**: which
models disagreed, about what, who changed their mind, and why.

---

> **First time here?** Read [docs/BRINGUP.md](docs/BRINGUP.md).
>
> The recommended setup is **API seats** — one OpenRouter key gives you a four-vendor panel, and they
> support the temperature control that the self-consistency check needs. The browser relay is still here
> and still the more interesting idea, but its selectors are unvalidated and UI-driven seats cannot do
> half the verification features.

## Quick start

```bash
npm install
```

```bash
npm run dev:engine
```

The engine listens on `127.0.0.1:8787`. On first run, if no panel is configured, it probes your machine
and proposes one: installed CLIs (`claude`, `gemini`, `codex`), a running Ollama or LM Studio, any API
keys in your environment, installed ChatGPT/Claude desktop apps, and the browser relay. Nothing is
enabled behind your back — it proposes, you pick. The panel is saved to `.data/seats.json`.

Then, in a second terminal:

```bash
npm run dev:ui
```

Open http://127.0.0.1:5173. The dev server proxies `/api` and `/ws` to the engine.

To serve the UI from the engine itself at http://127.0.0.1:8787 instead, build it once:

```bash
npm run build --workspace @consensus/ui
```

### Try it with no models at all

The protocol, the pruning, the stop conditions and the report all work against deterministic mock
seats, so you can see the whole machine run before spending a single message of real quota:

```bash
npm run eval -- --limit 20 --sweep
```

The mock panel is deliberately hostile: two honest-but-imperfect models, one that folds to the majority,
and one that never concedes. A protocol that only works with well-behaved seats is not telling you
anything.

---

## What actually happens when you press Run

**Is this even a question worth debating?** Prompts are classified `factual`, `computational`, `code`,
`creative` or `opinion`. Only the first three are debated — four different poems are not a disagreement,
and a run that would debate one exits immediately as `no_debate`. The classifier is a heuristic first and
only asks a model when it is unsure, and that call is placed on an unmetered seat and exempted from the
budget. You can override the decision per run with **Force debate**.

**Round 1 — parallel dispatch.** Your prompt goes to every enabled seat at once, verbatim. Each replies
with a prose answer and a short `answer_key`: the bare claim it is making.

**Is there anything to argue about?** The judge compares the `answer_key`s. If they all make the same
claim, the run is over — no debate, no wasted quota.

**Rounds 2+ — cross-examination.** Each model is shown the others' answers, anonymised as "Expert A/C/D"
with the letters reshuffled every round so nobody is permanently Expert A and no model knows it is
grading a competitor. Each round is two calls:

1. **Judge** — "are these the same claim?" No rewriting allowed.
2. **Revise** — "given that, what is your answer?" Only sent to models still under objection.

Those are separate calls on purpose: making a model judge and defendant in the same breath biases both.

**Pruning.** Once a critic concedes that a model is right, that critic is dropped from the model's
prompt in the next round. Context, cost and — the part that matters — peer pressure all shrink round over
round. Round 2 still shows everyone, because nothing has been conceded yet; pruning begins at round 3.

**Stopping.** Every run ends in a named outcome rather than a vague success/failure:

| Outcome | Meaning |
|---|---|
| `converged` | The judge finds the answers equivalent **and** no seat holds a standing objection. |
| `converged_contested` | Only one of those two signals holds. Reported honestly, with the split shown. |
| `no_debate` | Creative/opinion prompt, or fewer than two seats. |
| `unresolved` | Rounds ran out with the panel still split. |
| `oscillating` | The panel returned to a state it had already held. |
| `quorum_lost` | Fewer than two seats survived. |
| `budget_exhausted` / `timeout` / `aborted` / `error` | Ran out of messages, wall clock, or was stopped. |

Convergence needs **both** signals because a panel will happily vote to agree while its stated answers
still differ. **It never invents a consensus it did not observe.**

---

## Judges: what "the same answer" means

Equivalence is decided by a judge you choose per run, and the protocol layer does not care which one is
installed:

| Judge | How it decides | Notes |
|---|---|---|
| **Structured** (default) | Normalises and compares `answer_key`s, with a relative numeric tolerance | Deterministic, free, no extra calls |
| **Embedding** | Local embedding similarity | **Advisory only.** It never arbitrates a factual or computational question — see below |
| **LLM judge** | A dedicated model reads the prose and decides | Costs a call; lets you switch the marker protocol off entirely. Never one of the debating seats when there is another option |
| **Human** | You click "same / different" | The final arbiter when it matters |

The embedding judge is capped deliberately, and the measurements are the reason:

```
"It is safe to combine these drugs."  vs  "It is NOT safe ..."     cos 0.988
"The answer is 5."                    vs  "The answer is 6."       cos 0.932
"The answer is 5."                    vs  "It comes out to five."  cos 0.246
```

A direct negation scores higher than a correct paraphrase, so no threshold exists that accepts agreement
while rejecting contradiction. Its similarity score is still useful as a *supplementary* signal — "these
two agree, but for visibly different reasons" — and that is all it is used for.

---

## Verification: making agreement mean something

Panel agreement on its own is a weak signal. Two optional checks strengthen it, and both are **off by
default** because both cost real messages:

- **Self-consistency** (`selfConsistencySamples`, default `0`). Ask a seat the same question again at a
  higher temperature. A model that cannot reproduce its own answer should not count the same as one that
  can — and this catches the seat that happened to guess the majority answer once. Costs one call per
  sample per seat, and needs a seat that can set temperature, so UI-driven seats skip it.
- **Cross-check** (`crossCheck`, default `off`). After convergence, a seat that *disagreed* reviews the
  agreed answer cold, with no knowledge that others accepted it. A dissenter accepting is worth far more
  than another supporter repeating. Costs one call.

Both feed a **calibrated confidence** score that is never shown without its itemised factors — a bare
percentage you have to take on trust is worse than no number at all. The factors are:

`panel agreement` · `panel heterogeneity` · `self-consistency` · `position changes` ·
`independent agreement` · `cross-check` · `extraction fidelity` · `answer key quality` · `panel size`

Scores band as **low** (< 0.5), **moderate** (< 0.75) and **high**.

The heterogeneity term is the one to pay attention to. Four seats agreeing is not four independent votes
if they are four wrappers around the same base model, and the score says so explicitly instead of
treating seat count as evidence.

What the number is **not** is a probability that the answer is true. It measures how the panel behaved —
independence, consistency, whether anyone folded. The UI says exactly that under every score.

## The two settings that matter

**Agreement modulation** (`stubbornness`, 0–4, default **3**) is the primary tunable of this system, not
a footnote. The levels run from *Concede readily* to *Defend unless proven wrong*. Models fold toward the
majority even when they were right ([Sharma et al., ICLR 2024](https://arxiv.org/abs/2310.13548)), and
tuning exactly this dial is what took a losing multi-agent-debate protocol to state of the art
([Smit et al., ICML 2024](https://arxiv.org/abs/2311.17371)). It is wired into the prompt templates,
persisted per run, recorded in the report, and swept by the eval harness.

**Panel heterogeneity.** [Zhang et al. 2025](https://arxiv.org/abs/2502.08788) find model heterogeneity
is "a universal antidote" that consistently improves multi-agent debate — and that the configuration
which usually *underperforms* is one base model wearing several personas. Four models from four
different labs is the configuration this app is built for. A same-vendor panel gets a warning.

### Defaults

| Setting | Default |
|---|---|
| `stubbornness` | `3` — defend unless shown a concrete error |
| `judge` | `structured` |
| `maxRounds` | `4` |
| `perSeatRunBudget` | `12` messages |
| `callTimeoutMs` | `180000` (3 min per model call) |
| `runTimeoutMs` | `900000` (15 min per run) |
| `selfConsistencySamples` | `0` (off) |
| `crossCheck` | `false` (off) |
| `finalRewrite` | `false` |
| Engine concurrency | `8` calls in flight |

---

## Budget reality — read this before planning your day

A run is a **2–8 minute background job, not a chat turn**. Fire it and walk away; the UI is a monitor.

Calls are bounded and knowable. For `N` models over `R` rounds, worst case `N + 2N(R-1) + N` — four seats
over four rounds is 32 calls. Pruning takes 20–25% off that. Wall clock is not calls × latency — calls
within a round run in parallel, only rounds are serial.

The binding constraint is **per-seat quota, not total cost**. Each seat sees roughly 4–6 messages per
run. Against consumer subscription caps that leaves something like **6–12 questions per five-hour
window** on the tightest seat — and that seat's quota is shared with your normal use of that product.

So: the app shows a pre-flight estimate before every run, enforces per-run and per-day message budgets on
a rolling 24-hour window that survives restarts, treats quota exhaustion as a normal panel shrinkage
rather than an error, and prefers unmetered local seats for utility work. A mixed panel — two
subscription seats plus two local models — stretches the budget several times over.

---

## Transports

All families are first-class, and a single run routinely mixes them.

| Family | Adapters | Notes |
|---|---|---|
| **Browser relay** | `relay` | Drives your real, already-logged-in browser session via an extension. The flagship path; see below. |
| **CDP attach** | `cdp` | Attaches to a local Chrome/Edge started with `--remote-debugging-port`. Same page engine, no extension. Also drives a **dedicated app-owned profile** for unattended runs, and runs headless. |
| **Native desktop app** | `desktop` | Drives installed ChatGPT/Claude desktop apps through an external accessibility driver you configure (`trycua/cua`, a PowerShell UIA script, anything implementing the five verbs). Without one the seat reports `not_configured` cleanly. |
| **CLI** | `cli` | `claude`, `gemini`, `codex`. Subscription-backed, deterministic, zero UI fragility. Best default. |
| **Local models** | `ollama`, `lmstudio` | Ollama (`:11434`), LM Studio (`:1234`), Jan (`:1337`), llama.cpp (`:8080`), LocalAI (`:8081`), vLLM (`:8000`), text-generation-webui (`:5000`), GPT4All (`:4891`), KoboldCpp (`:5001`). Free, offline, unlimited, auto-discovered. |
| **API** | `openai`, `anthropic`, `google`, `openrouter` | Optional, key-gated. Also serves any OpenAI-compatible endpoint. |

### Seats degrade instead of dying

A seat can declare a **failover chain** — the same model reached several ways:

```json
{ "id": "chatgpt", "adapter": "relay", "options": { "provider": "chatgpt" },
  "fallbacks": [ { "adapter": "cdp",    "options": { "provider": "chatgpt", "port": 9222 } },
                 { "adapter": "openai", "options": { "apiKeyEnv": "OPENAI_API_KEY" } } ] }
```

Those transports fail for unrelated reasons — a relay breaks when the provider ships a UI change, a key
breaks when it runs out of credit — so they rarely break together. When the primary fails in a way
retrying cannot fix, the next takes over mid-run and the panel keeps its seat. The switch is logged and
shown, never silent: an answer that came from a metered API key instead of your subscription is
something you need to know.

Failover is deliberately conservative. It does **not** trigger on a content refusal (a different
transport to the same model refuses the same prompt), on an abort, or on a format violation.

### Errors are classified, not just counted

`429` because you sent three requests in a second is a two-second wait. `429` because your credit
balance is zero is terminal, and no amount of backoff fixes it. Every failure resolves to one of
`rate_limited`, `usage_cap`, `content_refused`, `network`, `login_expired`, `challenge`, `timeout`,
`non_compliant`, `budget_exhausted`, `not_configured`, `aborted` or `unknown` — each with a policy
(retryable, terminal, failover-worthy), the provider's own `Retry-After` where it gave one, and a
plain-English next step in the health strip.

### The browser relay

Load `packages/extension` as an unpacked extension, then paste the pairing token (printed by the engine,
stored at `.data/relay-token`) into its popup. The shipped descriptor pack covers **ChatGPT, Claude,
Gemini, Grok and DeepSeek**.

It is a **transport, not an agent**. It delivers an exact string and retrieves an exact string. No model
decides what to click — the action set is fixed and enumerable, and per-provider descriptors only say
*where* the fixed actions apply. Descriptors live in a versioned pack that hot-updates without shipping
a new build, because provider selectors break weekly.

Three things it does that most scrapers get wrong:

- **Completion detection** uses a composite signal (stop button reverting, action row appearing, aria
  settling, mutation quiescence) — "the text stopped changing" is not a completion signal, because
  streaming stalls mid-answer all the time.
- **Extraction** clicks the provider's own copy button and **intercepts the write in the page**, rather
  than reading the clipboard back. Reading it back is impossible in a background tab — the Clipboard API
  requires document focus — and this app deliberately never steals focus. Intercepting the write also
  means your real clipboard is never touched, and the extension requests **no clipboard permissions at
  all** (`tabs`, `scripting`, `storage`, `alarms`, `offscreen`, and host access to the five chat
  origins). Where a provider's copy button turns out not to yield source markdown, the seat is marked
  **LOSSY** rather than quietly returning mangled text.
- **The connection survives.** The WebSocket lives in an offscreen document, not the service worker,
  because an MV3 worker is killed after ~30s idle — which is most of a run, since models spend minutes
  generating. This is the single most common failure in this architecture; see
  [docs/BUGS-FOUND.md](docs/BUGS-FOUND.md).

Delivery never types character by character (a typed newline sends the message). It pastes, reads the
composer back, and **refuses to submit unless it matches your text byte for byte**.

The page-side engine (`packages/extension/src/page-core.js`) is shared verbatim by the extension and the
CDP transport — one implementation, injected two ways. The completion-detection and extraction code is
exactly where silent drift would be most expensive.

---

## Honest risks

- Automating provider web UIs and desktop apps is generally **contrary to those providers' terms of
  use**, and accounts can be rate-limited or suspended. You are choosing this consciously.
- UI adapters break when providers ship UI changes. The hot-updatable descriptor pack and the
  conformance smoke test are the mitigation, not a promise of stability. A red conformance chip after a
  provider redesign is the expected state, not a bug.
- **The relay selectors have never been validated against a live logged-in session.** This is the
  largest known unknown in the project; `npm run conformance` is what closes it. See
  [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).
- Seats on the same account share a quota, and the app does not yet coordinate budgets across them.
- **Convergence is not correctness.** Models trained on overlapping data share errors. Four models can
  be confidently, identically wrong, and this app will report that as agreement. It tells you what the
  panel thinks, not what is true.
- The published evidence on multi-agent debate is mixed at best — see [docs/EVIDENCE.md](docs/EVIDENCE.md).
  Run the eval harness against your own panel before trusting the protocol over a single good model.

There is a one-click **kill switch** that stops all automation immediately, and a separate "disable all
UI automation" switch that falls the panel back to CLI/local/API seats, so a broken descriptor pack can
never brick the app.

---

## Privacy

Local-first. Nothing leaves your machine except to the model providers you enabled. Credentials and
cookies stay in your browser — the app never reads, copies or stores session tokens. API keys are read
from environment variables by name; the seat config file stores the variable name (`apiKeyEnv`), never
the value, so it is safe to copy or share.

Everything the automation layer does is written to a hash-chained activity log — each entry commits to
the previous one — which you can inspect, filter and verify in the **Activity** tab.

The engine binds to loopback by default. Binding beyond it (for the phone path) is an explicit, logged
choice.

---

## Configuration

Everything the app writes lives in `.data/` at the repo root: `seats.json`, `settings.json`,
`consensus.sqlite`, `relay-token`, `descriptors.json`, template overrides and run exports. Delete a
file to get its default back.

| Variable | Default | Purpose |
|---|---|---|
| `CONSENSUS_HOST` | `127.0.0.1` | Bind address. Change only if you want LAN access. |
| `CONSENSUS_PORT` | `8787` | Engine HTTP/WS port. |
| `CONSENSUS_DATA_DIR` | `<repo>/.data` | Where all local state goes. |
| `CONSENSUS_CONCURRENCY` | `8` | Max model calls in flight engine-wide. |
| `CONSENSUS_DESCRIPTOR_PACK` | `<data>/descriptors.json` | Point at a custom relay descriptor pack. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

A ready-made four-vendor OpenRouter panel is in [examples/seats.openrouter.json](examples/seats.openrouter.json):

```bash
mkdir -p .data && cp examples/seats.openrouter.json .data/seats.json
```

---

## Commands

```bash
npm run dev             # engine and UI together, in one terminal
```

```bash
npm run dev:engine      # engine + API on 127.0.0.1:8787
```

```bash
npm run dev:ui          # UI dev server on 127.0.0.1:5173, proxying to the engine
```

```bash
npm test                # 155 tests across 9 files
```

```bash
npm run typecheck       # tsc -b over shared + engine
```

```bash
npm run build           # build shared, engine, then the UI bundle
```

```bash
npm start               # run the engine without file watching
```

**Eval** — does this protocol actually beat a single good model?

```bash
npm run eval                    # mock panel, protocol vs single model vs self-consistency
```

```bash
npm run eval -- --sweep         # sweep the agreement-modulation dial (0, 2, 3, 4)
```

```bash
npm run eval -- --real          # use the seats configured in the app
```

```bash
npm run eval -- --limit 10 --k 5
```

Results are written to `eval-results/<timestamp>.{md,json}`. The verdict text says "retune it" rather
than "ship it" when the protocol loses — an eval that only ever congratulates you is worthless.

**Conformance** — is each seat actually usable?

```bash
npm run conformance             # every enabled seat: reachable, 2+2, byte-exact LaTeX
```

```bash
npm run conformance -- --seat claude-cli
```

```bash
npm run conformance -- --fidelity   # full fixture suite, not just LaTeX
```

---

## The UI

Five tabs, keyboard-switchable with <kbd>1</kbd>–<kbd>5</kbd>:

**Run** — the prompt box, per-run settings, live round-by-round progress, the divergence view and the
report. **Transport** — per-seat health: family, conformance chip, quota meter, failure reason, re-heal
button, and seat discovery. **Scoreboard** — lifetime per-model record built from your own questions:
right first, overruled, persuaded others, flips, *talked out of correct*, withdrawals, non-compliance.
**Activity** — the hash-chained automation log with a chain-integrity check. **Prompts** — every template
the app sends, editable; edits shadow the shipped defaults and survive updates.

---

## Layout

```
packages/
  shared/      types, wire protocol, descriptor schema, expert-letter assignment
  engine/      orchestrator, adapters, judges, persistence, HTTP/WS API, eval harness
    templates/ the 9 prompts the app sends — user-editable, no hard-coded strings
    fixtures/  text-fidelity fixtures (LaTeX, code, RTL, unicode; 10k chars generated)
    test/      155 tests: protocol, parser, judges, store, transport, self-heal, fidelity
  ui/          React monitor: rounds, divergence, report, scoreboard, health, activity
  extension/   MV3 browser relay
docs/          architecture, bring-up, evidence base, design notes, bugs found
examples/      ready-made seat configurations
```

| Doc | What it is |
|---|---|
| [docs/BRINGUP.md](docs/BRINGUP.md) | Getting to your first real answer. Start here. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a run flows through the system, and what is easy to get subtly wrong. |
| [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md) | Decisions that could have gone the other way, bugs testing caught, and the known gaps. |
| [docs/EVIDENCE.md](docs/EVIDENCE.md) | The published research on multi-agent debate, including the parts that argue against this app. |
| [docs/BUGS-FOUND.md](docs/BUGS-FOUND.md) | Failure modes of this architecture, found the hard way. |

The engine and the UI are separate processes talking over HTTP/WebSocket. That is deliberate: it is what
makes the phone path work (desktop runs the engine, phone opens the same UI over the LAN) and it keeps
orchestration logic independent of any UI framework.

## Requirements

Node **22.5+** — the app uses the built-in `node:sqlite`, so there is no native module to compile and
`npm install` cannot fail on node-gyp. The engine has exactly one runtime dependency (`ws`).

## License

MIT — see [LICENSE](LICENSE).
