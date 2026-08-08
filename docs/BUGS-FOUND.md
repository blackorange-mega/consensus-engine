# Bugs found and fixed

Two sources: published issues in projects doing the same thing (OpenClaw, Chrome
extensions generally, OpenAI-compatible servers), and bugs this build's own
tests turned up. Each entry says what breaks, how it was found, and what the fix
actually does — so you can disagree with any of them.

---

## Found by research — known failures in this architecture

### 1. The relay dies after 30 seconds of quiet (fatal)

**Symptom.** The extension disconnects mid-run, tabs detach, and the panel loses
every browser seat. Reconnecting by hand works until it happens again.

**Cause.** An MV3 service worker is terminated after ~30s idle, taking the
WebSocket and all attached state with it. Chrome 116+ resets the idle timer on
WebSocket traffic, which sounds like it solves the problem and does not: a run
spends most of its time *waiting* for a model to generate, and that is exactly
when the worker dies.

This is not hypothetical — OpenClaw has an open issue describing the identical
failure in the identical architecture
([openclaw#25228](https://github.com/openclaw/openclaw/issues/25228)), and their
relay pings every 5 seconds and still loses connections under memory pressure.

**Fix.** The WebSocket moved out of the service worker into an **offscreen
document**, which is not subject to the service worker lifecycle at all
([Chrome docs](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)).
The worker keeps tabs and scripting; the offscreen document keeps the
connection. Plus an application-level ping every 20s so a zombie socket is
detected in seconds rather than at the next action, and a `chrome.alarms`
heartbeat so the worker is warm when an action arrives.

### 2. Clipboard extraction cannot work in a background tab (fatal)

**Symptom.** The copy-button path — the whole non-lossy extraction strategy —
fails with `DOMException: Document is not focused` for every tab that is not the
focused one.

**Cause.** `navigator.clipboard.readText()` requires document focus. This relay
deliberately keeps provider tabs warm in the background and never steals focus,
so the read fails on essentially every real run. Focusing each tab in turn would
"fix" it and destroy the product: a run is a multi-minute background job that
must not fight the user for their screen. Known and unresolved upstream
([issuetracker 41497480](https://issuetracker.google.com/issues/41497480)).

**Fix.** Stop reading the clipboard. **Intercept the write instead.** A
MAIN-world shim patches `navigator.clipboard.writeText`, `clipboard.write` and
`document.execCommand('copy')`, plus a capture-phase `copy` listener. While the
relay is capturing, the patched call records the exact string and *suppresses*
the real write.

Three things fall out of this beyond fixing the bug:

- it works in unfocused background tabs, because no focus is involved;
- the user's real clipboard is **never touched**, so the save/restore dance and
  the cross-tab clipboard mutex both disappear;
- the `clipboardRead` and `clipboardWrite` permissions were **removed from the
  manifest entirely** — the extension now asks for strictly less access than it
  did while working strictly better.

### 3. `tabs.sendMessage` fails on exactly the tabs users already have open

**Symptom.** `Could not establish connection. Receiving end does not exist.`

**Cause.** Chrome does not re-inject manifest-declared content scripts into
already-open tabs after an install, update or reload. So the failure lands
precisely on the ChatGPT tab the user has had open all day — the most likely
tab, not an edge case.

**Fix.** A liveness ping before every action, and on-demand injection through
`chrome.scripting.executeScript` with retries. The page script is idempotent, so
re-injection is free.

### 4. `stream_options` is rejected by several OpenAI-compatible servers

**Symptom.** A local model that works in every other client returns 400 here.

**Cause.** `stream_options: {include_usage: true}` is an OpenAI extension.
LM Studio, and some vLLM and llama.cpp builds, either reject it or handle it
inconsistently — all three have open issues
([lmstudio#676](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/676),
[vllm#7262](https://github.com/vllm-project/vllm/issues/7262),
[llama.cpp#12102](https://github.com/ggml-org/llama.cpp/issues/12102)).

**Fix.** Detect the rejection, clear the capability for that endpoint, and retry
once without it. Losing token counts is a much better outcome than losing the
answer.

---

## Found by this build's own tests

### 5. Turns were not storing their parsed answers

The report timeline and the eval's sycophancy metrics were both silently reading
empty strings. Surfaced when the eval reported `rescued: 0` on a question the
protocol had visibly rescued.

### 6. Objections went stale within a round

Objections are stated in the judge call, *before* the revise call changes
positions. A seat that adopted its critic's own claim still carried the
objection, so clean convergences were downgraded to `converged_contested`. Fixed
by dropping an objection when the two seats' answer keys now match — compared,
not assumed.

### 7. The creative-prompt classifier missed almost every real phrasing

The regex required the noun to follow the determiner directly, so *"write me a
**short** poem"* classified as `factual` and got debated — burning subscription
quota to manufacture a verdict on a poem.

### 8. Letter-keyed critiques carried across a reshuffle

Expert letters are reshuffled every round, so a letter-keyed critique is only
meaningful inside its own round. Carrying one forward would have reassigned
objections to the wrong models — a silent corruption that would have looked like
models randomly changing their minds. Objections are now resolved to seat ids at
the moment they are recorded.

### 9. Classification was spending a panel seat's message budget

With an all-metered panel, the task classifier consumed a seat's entire per-run
budget and dropped it from the run *before it had answered anything*. Now the
classifier only runs on an unmetered seat, and its call is exempt from the
budget. With no free seat available, the heuristic stands on its own.

### 10. An unreadable cross-check was recorded as a rejection

Caught in live testing of the new verification layer. If the reviewing model's
reply could not be parsed, `agrees` defaulted to `false` and confidence took a
22-point hit for a review that never happened. Inventing a negative signal is
the same class of failure as inventing a positive one. Now recorded as
inconclusive and omitted from the calculation.

### 11. `deriveKeyFromAnswer` returned markdown headings

`"# Heading\n\nThe answer is 42."` yielded `"Heading"` as the claim to compare.

---

## Deliberately not fixed

- **Descriptor selectors are still unvalidated.** They were never tested against
  live logged-in sessions and `copyYieldsMarkdown` is `assumed` for every
  provider. This is not fixable from here — it needs a real session. The
  conformance test exists to turn the assumption into a measurement, and a red
  chip after a provider redesign is the expected state.
- **Run resume.** Interrupted runs are detected and every turn is persisted, but
  continuing a half-finished run from stored state is not wired up. Doing it
  properly means rebuilding positions, standing objections and per-round letter
  maps from the turn log; doing it carelessly means resuming with a corrupted
  debate graph, which is worse than starting again.

> Descriptor self-healing was on this list and is no longer — it is built, with
> validate-before-cache and rollback. See `relay/selfHeal.ts`.

---

## Second pass — found by auditing this build

### 12. New DB column broke every existing install (fatal on upgrade)

`CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so
adding `verification_json` to the schema silently did nothing for anyone who had
run the app before — and then **every run save failed** with "table runs has no
column named verification_json". Reproduced against a simulated previous-release
database before fixing.

Fixed with a migration runner (`db/migrate.ts`) that declares additive columns
separately and applies them with `ALTER TABLE ADD COLUMN` when missing, plus a
startup self-check that reports a mismatch at boot rather than mid-run. Covered
by `store.test.ts`, including that an existing run survives the upgrade intact.

### 13. Adapters were never disposed

The engine rebuilt its adapter map on every seat toggle and simply dropped the
old one. CDP seats hold a WebSocket to a browser and desktop seats hold a child
process, so both leaked — once per toggle, and again on shutdown. Now disposed
on rebuild (skipping any adapter still in use) and awaited on close.

### 14. Verification calls were missing from the pre-flight estimate

Self-consistency and cross-check spend real messages, but the estimate shown
before a run ignored them — so enabling verification quietly overran the number
the user had just been shown. Both are now in the call count and the serial-step
count.

### 15. Desktop seats could never be approved

`DesktopAdapter.confirmAutomation()` existed and the adapter refused to send
until it was called, but nothing ever called it — the confirm-before-first-send
guardrail made desktop seats permanently unusable. Now exposed as
`POST /api/seats/:id/confirm`, and it reaches through a failover chain to find
the desktop transport inside it.

### 16. Dead code that would have misled the next reader

- `openTurns` in the orchestrator: written on every call, never read.
- `expectedShape` imported but unused after the repair prompt moved to a template.
- `sessionId` in the CDP adapter: always null, since we attach directly to the
  page target and no session is involved.
- `lastSeen` in the relay server: recorded but never read. Rather than delete it,
  it now backs a `stale` flag — the socket can be open while the extension has
  gone quiet, and that used to look identical to healthy.

### 17. The relay had one chance to connect and no way to recover

**Symptom.** Extension loaded, offscreen document alive, correct token in
storage — and the engine log showed *zero* connection attempts. Not a rejected
one. Nothing.

**Cause.** `connect()` ran once when the offscreen document was created. At that
moment the user had not pasted the token yet, so it logged "no pairing token
set" and **returned without scheduling anything**. Pasting the token afterwards
only helped if a single message hop (popup → service worker → offscreen)
happened to land, and that hop was wrapped in `.catch(() => {})`, so when it did
not land there was no trace of it anywhere.

The result was the worst kind of failure: a valid configuration, a live process,
and permanent silence.

**Fix.** Three changes, because the real defect was the absence of any recovery
path rather than one broken call:

- a `chrome.storage.onChanged` listener, so pairing takes effect the instant the
  token is saved and the fragile message hop is no longer load-bearing;
- a 15-second retry backstop, which covers every failure mode rather than the
  ones we anticipated — including the common case of the engine not being
  started yet;
- `lastError` is recorded and returned to the popup, so "not connected" now
  comes with a reason instead of a grey badge.

Found by inspecting live state on a real machine, not by a test. Worth noting as
a limit of the test suite: everything here was individually correct, and the bug
was in what happened between the pieces.
