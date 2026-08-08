# Design notes: decisions, trade-offs and known gaps

The choices in this build that are worth arguing with, the bugs that testing caught, and the things
that are honestly not finished. Written down so each one can be challenged or reverted.

---

## Decisions that could reasonably have gone the other way

### 1. Phase 1 asks for a bare claim alongside the answer

The obvious phase-1 prompt is just *"Output only the answer. No preamble, no closing remarks, no
commentary."* But equivalence is decided on a short canonical `answer_key`, and a phase-1 reply that
contains only prose has no key to compare.

The dispatch template therefore asks for the answer followed by one fenced `key` block, and the block is
stripped from the answer before display. It is conditional (`{{#require_key}}`) and switches off when the
LLM judge is selected, since that judge reads plain prose.

Without this, the default judge has nothing to work with on round 1.

### 2. `answer_key` is part of the verdict contract

The natural verdict shape is `{"agree", "answer", "critiques"}`, but deciding agreement needs a canonical
key to compare rather than free prose. So `answer_key` is carried in the contract in both the judge and
revise templates. The legacy sentinel path is unchanged.

### 3. Convergence requires two signals, not one

"Every model returned the agreement token, therefore converged" is not safe on its own: a panel can vote
to agree while its stated answers still differ — models do this. So a run is `converged` only when the
structured judge finds the answers equivalent **and** no seat holds a standing objection.

Either signal alone produces a distinct outcome, `converged_contested`, whose report says which way it is
contested. This is what keeps the app from ever inventing a consensus it did not observe.

### 4. Cross-examination is pruned from round 3, not round 2

Conceded critics are pruned out of the *next* round. Round 2 therefore shows every seat all the others
(nothing has been conceded yet), and pruning begins at round 3. A seat with no critics left skips both of
its calls entirely, which is where most of the saving comes from.

### 5. No shadcn/ui or Radix

Neither was installed: shadcn requires a generator step that copies source into the repo, and Radix adds a
large dependency tree to an app that holds access to the user's authenticated sessions. The UI is
hand-written CSS with a token system in the same visual register (dark-first, dense, calm). Swapping in
shadcn later touches only `packages/ui`.

The same reasoning kept the engine's runtime dependencies at exactly one (`ws`): request validation is
hand-written rather than pulled from a schema library.

### 6. Tauri packaging is documented, not built

Tauri needs a Rust toolchain, which would make `npm install` fail on a machine that does not have one.
The architectural requirement Tauri was there to satisfy — engine as a separate process from the UI — is
met already, so packaging can be added without restructuring anything.

### 7. Native desktop control ships as a driver contract, not an OS backend

Rather than writing three OS backends, `DesktopAdapter` speaks a small JSON-over-stdio protocol
(`probe`, `newThread`, `send`, `awaitAndExtract`, `abort`) to an external driver the user configures —
`trycua/cua`, a PowerShell UIA script, or anything else implementing the five verbs. Without a driver the
seat reports `not_configured` cleanly. The protocol and the guardrails it must honour are documented in
the adapter.

---

## Things the build needed that were not obvious up front

### Deterministic mock seats with adversarial personas

An eval you cannot run without spending subscription quota is an eval nobody runs. Mock seats implement
the behaviours the protocol has to survive — `truthful`, `wrong`, `sycophant`, `stubborn`, `malformed`,
`injector` — so the whole machine can be exercised with `npm run eval` and zero configuration.

The `injector` persona is what makes the prompt-injection defence testable end to end: it genuinely
attempts an injection through its answer, and a test asserts it cannot forge a consensus.

The mocks also read the agreement-modulation clause back out of the prompt and modulate accordingly. That
turns the stubbornness sweep into a real end-to-end test of the dial: if a template edit or wiring change
stops the setting reaching the prompt, the sweep flattens and the harness shows it.

### "Majority accuracy" as a separate eval metric

An unresolved run returns no answer by design, which scores as a miss. That conflates *"the panel was
wrong"* with *"the panel knew the answer but one seat blocked unanimity"*. The harness reports both, and
the verdict text calls out the gap when it is large — it usually means a seat that never concedes.

### Hash-chained audit log

The activity log is hash-chained, each entry committing to the previous, and the UI shows a
chain-integrity check. The log is the user's only evidence of what was done inside their accounts, so
tampering with it should be detectable rather than silent.

### `node:sqlite` instead of a native SQLite binding

Zero native dependencies means `npm install` cannot fail on node-gyp on a machine with no compiler. For a
local-first desktop app aimed at non-developers this is the difference between installable and not.

### Classification never spends metered quota

The LLM classifier only runs on an unmetered seat (Ollama/LM Studio/mock), and its call is exempt from
the per-run budget. Found by a test: with a metered panel the classify call was consuming a seat's entire
per-run budget and dropping it from the run *before it had answered anything*.

### Pre-flight estimate, budget ledger, unmetered preference

The call arithmetic is implemented rather than just documented: the estimate is shown before the run,
per-run and per-day caps are enforced with a rolling window that survives restarts, and exhaustion is a
normal circuit-breaker drop.

### Fidelity assertions that fail loudly

`assertVerbatim` runs during prompt construction: if a template edit ever reflows or paraphrases the user
prompt, prompt building throws instead of quietly changing what the panel is debating. The fixture suite
(LaTeX, nested code fences, Persian RTL with bidi controls, ZWJ emoji and combining marks, 10k chars) is
asserted through every prompt path.

### Report caveats for the non-converged outcomes

The report originally said nothing when a run ended unresolved or oscillating. It now explains why no
answer was returned, reports the largest camp as an observed count rather than a verdict, and names the
likely cause when the panel was cycling.

---

## Bugs found by testing this build

Recorded because they are the kind that would have shipped silently.

1. **Turns were not storing their parsed answers.** The report timeline and the eval's sycophancy metrics
   were both reading empty strings. Found because the eval reported `rescued: 0` on a question the
   protocol had visibly rescued.

2. **Objections went stale within a round.** Objections are stated in the judge call, before the revise
   call changes positions. A seat that adopted its critic's own claim still carried the objection, so
   clean convergences were being reported as `converged_contested`. Fixed by dropping an objection when
   the two seats' answer keys now match.

3. **The creative-prompt classifier missed almost every real phrasing.** The regex required the noun to
   follow the determiner directly, so *"write me a **short** poem"* classified as `factual` and got
   debated — burning quota to manufacture a verdict on a poem.

4. **Letter-keyed critiques carried across a reshuffle.** Caught while writing the fold logic rather than
   by a test. Since letters are reshuffled every round, carrying a letter-keyed verdict forward would
   have reassigned objections to the wrong models — a silent corruption that would have looked like
   models randomly changing their minds.

5. **`deriveKeyFromAnswer` returned markdown headings.** `"# Heading\n\nThe answer is 42."` yielded
   `"Heading"` as the claim to compare.

---

## Known gaps

Stated plainly rather than left to be discovered.

### Cannot be closed from here — needs a real logged-in session

- **The descriptor pack selectors are unvalidated.** They were never tested against a live authenticated
  session, and `copyYieldsMarkdown` is `assumed` for every provider. This is the single largest unknown in
  the project, and no amount of local work closes it: it needs someone signed in to
  ChatGPT/Claude/Gemini/Grok running `npm run conformance`. Everything around it is built to cope — the
  conformance test turns the assumption into a per-provider measurement, self-healing proposes repairs,
  and a copy button that fails the LaTeX round trip marks the seat LOSSY rather than quietly returning
  mangled text.
- **The relay and CDP transports have never been exercised end to end.** Every layer has unit tests, the
  page engine parses and installs, and the protocol above them is covered — but "the extension pastes
  into a real ChatGPT composer and gets the answer back byte-exact" has not happened. Treat first use as
  a bring-up exercise with the conformance suite as the checklist.

### Real remaining limitations

- **Run resume is still partial.** Interrupted runs are detected and reported at boot and every turn is
  persisted, but continuing a half-finished run from stored state is not wired up. Doing it properly
  means reconstructing positions, standing objections and per-round letter maps from the turn log; doing
  it carelessly means silently resuming with a corrupted debate graph, which is worse than restarting.
  Left undone deliberately rather than half-built.
- **Self-healing is heuristic, not model-driven.** A vision/DOM LLM pass would be the fancier option.
  What is built is deterministic DOM rediscovery — largest editable box, buttons labelled copy/send/stop,
  assistant-role containers — validated against a real smoke test before anything is cached, with
  rollback if it fails. For this specific job that is arguably better than an LLM: free, instant, and
  incapable of hallucinating a plausible-looking selector. It will not cope with a genuinely novel layout.
- **The eval's protocol condition still loses to self-consistency on the mock panel** (50% vs 76.7% at
  ~12x the calls). Majority accuracy is 96.7%, so the panel holds the right claim and unanimity is what
  fails — the mock panel deliberately contains a seat that never concedes. This is a statement about the
  mock personas, not about real models. Run `npm run eval -- --real --sweep` before drawing conclusions.
- **No rate limiting shared across seats on one account.** Two seats pointed at the same provider account
  each track their own budget and can independently trip a shared limit. The circuit breaker handles the
  resulting 429 correctly, so this is reactive rather than preventative.
- **Subscription message caps in the docs are approximate** and change often. Re-verify before relying on
  the per-seat arithmetic.

### Closed since the first draft

- CDP attach and the dedicated automation profile — **built**.
- Descriptor self-healing — **built**, with validate-before-cache and rollback.
- The golden set — now **100 items**, with every arithmetic answer computed rather than typed, so the
  benchmark cannot be wrong about its own ground truth.
- Schema migrations — **built**, after confirming the previous release's databases would have broken on
  upgrade.
