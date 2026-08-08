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

The engine probes your machine on first run and proposes a panel: installed CLIs (`claude`, `gemini`,
`codex`), a running Ollama or LM Studio, any API keys in your environment, and the browser relay. Then:

```bash
npm run dev:ui
```

Open http://127.0.0.1:5173. To serve the UI from the engine instead, build it once:

```bash
npm run build --workspace @consensus/ui
```

### Try it with no models at all

The protocol, the pruning, the stop conditions and the report all work against deterministic mock
seats, so you can see the whole machine run before spending a single message of real quota:

```bash
npm run eval -- --limit 20 --sweep
```

---

## What actually happens when you press Run

**Round 1 — parallel dispatch.** Your prompt goes to every enabled seat at once, verbatim. Each replies
with a prose answer and a short `answer_key`: the bare claim it is making.

**Is there anything to argue about?** A judge compares the `answer_key`s. If they all make the same
claim, the run is over — no debate, no wasted quota.

**Rounds 2+ — cross-examination.** Each model is shown the others' answers, anonymised as "Expert A/C/D"
with the letters reshuffled every round so nobody is permanently Expert A and no model knows it is
grading a competitor. Each round is two calls:

1. **Judge** — "are these the same claim?" No rewriting allowed.
2. **Revise** — "given that, what is your answer?" Only sent to models still under objection.

Those are separate calls on purpose: making a model judge and defendant in the same breath biases both.

**Pruning.** Once a critic concedes that a model is right, that critic is dropped from the model's
prompt next round. Context, cost and — the part that matters — peer pressure all shrink round over round.

**Stopping.** The run ends when the panel agrees, when it starts cycling between positions it has
already held, when it runs out of rounds, budget or time, or when fewer than two models are left. If it
did not agree, it says so and shows you the camps. **It never invents a consensus it did not observe.**

---

## Verification: making agreement mean something

Panel agreement on its own is a weak signal. Three optional checks make it worth more, each shown with
its own contribution rather than folded into an opaque score:

- **Self-consistency.** Ask a seat the same question again at a higher temperature. A model that cannot
  reproduce its own answer should not count the same as one that can — and this catches the seat that
  happened to guess the majority answer once. Costs one message per sample per seat.
- **Cross-check.** After convergence, a seat that *disagreed* reviews the agreed answer cold, with no
  knowledge that others accepted it. A dissenter accepting is worth far more than another supporter
  repeating. Costs one message.
- **Calibrated confidence.** Combines panel agreement, **vendor heterogeneity**, self-consistency,
  capitulation (flip count), extraction fidelity and the cross-check into one itemised score.

The heterogeneity term is the one to pay attention to. Four seats agreeing is not four independent votes
if they are four wrappers around the same base model, and the score says so explicitly instead of
treating seat count as evidence.

What the number is **not** is a probability that the answer is true. It measures how the panel behaved —
independence, consistency, whether anyone folded. The UI says exactly that under every score.

## The two settings that matter

**Agreement modulation** (`stubbornness`, 0–4) is the primary tunable of this system, not a footnote.
Models fold toward the majority even when they were right ([Sharma et al., ICLR 2024](https://arxiv.org/abs/2310.13548)),
and tuning exactly this dial is what took a losing multi-agent-debate protocol to state of the art
([Smit et al., ICML 2024](https://arxiv.org/abs/2311.17371)). It is wired into the prompt templates,
persisted per run, recorded in the report, and swept by the eval harness. Start at 3.

**Panel heterogeneity.** [Zhang et al. 2025](https://arxiv.org/abs/2502.08788) find model heterogeneity
is "a universal antidote" that consistently improves multi-agent debate — and that the configuration
which usually *underperforms* is one base model wearing several personas. Four models from four
different labs is the configuration this app is built for. A same-vendor panel gets a warning.

---

## Budget reality — read this before planning your day

A run is a **2–8 minute background job, not a chat turn**. Fire it and walk away; the UI is a monitor.

Calls are bounded and knowable. For `N` models over `R` rounds, worst case `N + 2N(R-1) + N`. Pruning
takes 20–25% off that. Wall clock is not calls × latency — calls within a round run in parallel, only
rounds are serial.

The binding constraint is **per-seat quota, not total cost**. Each seat sees roughly 4–6 messages per
run. Against consumer subscription caps that leaves something like **6–12 questions per five-hour
window** on the tightest seat — and that seat's quota is shared with your normal use of that product.

So: the app shows a pre-flight estimate before every run, enforces per-run and per-day message budgets,
treats quota exhaustion as a normal panel shrinkage rather than an error, and prefers unmetered local
seats for utility work. A mixed panel — two subscription seats plus two local models — stretches the
budget several times over.

---

## Transports

All families are first-class, and a single run routinely mixes them.

| Family | What it is | Notes |
|---|---|---|
| **Browser relay** | Drives your real, already-logged-in browser session via an extension | The flagship path. See below. |
| **CDP attach** | Attaches to a local Chrome/Edge started with `--remote-debugging-port` | Same page engine, no extension. Also drives a **dedicated app-owned profile** for unattended runs, and runs headless. |
| **Native desktop app** | Drives installed ChatGPT/Claude desktop apps via OS accessibility APIs | Needs an external driver; see `adapters/desktop.ts` |
| **CLI** | `claude`, `gemini`, `codex` | Subscription-backed, deterministic, zero UI fragility. Best default. |
| **Local models** | Ollama, LM Studio, Jan, llama.cpp, vLLM, LocalAI, GPT4All, KoboldCpp, text-generation-webui | Free, offline, unlimited. Auto-discovered on their usual localhost ports. |
| **API** | OpenAI-compatible, Anthropic, Google, OpenRouter | Optional, key-gated |

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
balance is zero is terminal, and no amount of backoff fixes it. Every failure resolves to a policy —
retryable, terminal, failover-worthy, plus the provider's own `Retry-After` where it gave one — and a
plain-English next step shown in the health strip.

### The browser relay

Load `packages/extension` as an unpacked extension, then paste the pairing token (printed by the engine,
stored at `.data/relay-token`) into its popup.

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
  means your real clipboard is never touched, and the extension needs no clipboard permissions at all.
  Where a provider's copy button turns out not to yield source markdown, the seat is marked **LOSSY**
  rather than quietly returning mangled text.
- **The connection survives.** The WebSocket lives in an offscreen document, not the service worker,
  because an MV3 worker is killed after ~30s idle — which is most of a run, since models spend minutes
  generating. This is the single most common failure in this architecture; see
  [docs/BUGS-FOUND.md](docs/BUGS-FOUND.md).

Delivery never types character by character (a typed newline sends the message). It pastes, reads the
composer back, and **refuses to submit unless it matches your text byte for byte**.

The page-side engine (`packages/extension/src/page-core.js`) is shared verbatim by the extension and the
CDP transport. One implementation, three delivery mechanisms — the completion-detection and extraction
code is exactly where silent drift would be most expensive.

---

## Honest risks

- Automating provider web UIs and desktop apps is generally **contrary to those providers' terms of
  use**, and accounts can be rate-limited or suspended. You are choosing this consciously.
- UI adapters break when providers ship UI changes. The hot-updatable descriptor pack and the
  conformance smoke test are the mitigation, not a promise of stability. A red conformance chip after a
  provider redesign is the expected state, not a bug.
- Seats on the same account share a quota.
- **Convergence is not correctness.** Models trained on overlapping data share errors. Four models can
  be confidently, identically wrong, and this app will report that as agreement. It tells you what the
  panel thinks, not what is true.
- The published evidence on multi-agent debate is mixed at best — see `docs/EVIDENCE.md`. Run the eval
  harness against your own panel before trusting the protocol over a single good model.

There is a one-click **kill switch** that stops all automation immediately, and a separate "disable all
UI automation" switch that falls the panel back to CLI/local/API seats, so a broken descriptor pack can
never brick the app.

---

## Privacy

Local-first. Nothing leaves your machine except to the model providers you enabled. Credentials and
cookies stay in your browser — the app never reads, copies or stores session tokens. API keys are read
from environment variables by name; the seat config file stores the variable name, never the value.

Everything the automation layer does is written to a hash-chained activity log you can inspect, filter
and verify in the Activity tab.

---

## Commands

```bash
npm run dev:engine      # engine on :8787
npm run dev:ui          # UI on :5173
npm test                # 155 tests
npm run eval            # protocol vs single model vs self-consistency
npm run eval -- --sweep # sweep the agreement-modulation dial
npm run conformance     # per-seat smoke test: reachable, 2+2, byte-exact LaTeX
npm run typecheck
```

## Layout

```
packages/
  shared/      types, wire protocol, descriptor schema, expert-letter assignment
  engine/      orchestrator, adapters, judges, persistence, HTTP/WS API, eval harness
    templates/ every prompt the app sends — user-editable, no hard-coded strings
    fixtures/  text-fidelity fixtures (LaTeX, code, RTL, emoji, 10k chars)
  ui/          React monitor: rounds, divergence, report, scoreboard, health, activity
  extension/   MV3 browser relay
docs/          architecture, evidence base, design notes and known gaps
examples/      ready-made seat configurations
```

The engine and the UI are separate processes talking over HTTP/WebSocket. That is deliberate: it is what
makes the phone path work (desktop runs the engine, phone opens the same UI over the LAN) and it keeps
orchestration logic independent of any UI framework.
