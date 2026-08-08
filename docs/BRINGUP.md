# Bring-up: getting to your first real answer

The protocol, judges, parser, sanitiser, budget layer and verification are all
built and tested. What is left is choosing where the answers come from.

**Recommended path: API seats.** They make the whole product work, including the
parts browser seats cannot do, and they make the central question answerable.

---

## Why APIs first

| | API seats | Browser relay |
|---|---|---|
| Self-consistency check | **works** | skipped — UI seats cannot vary temperature |
| Token counts / cost tracking | **yes** | no |
| Runs before you hit a wall | hundreds | ~6-12 per 5 hours |
| Breaks when a provider redeploys | no | yes, by design |
| Terms-of-use risk | none | real |
| Cost | per token | uses subscriptions you already pay for |

The last row is the only one favouring the relay, and it is why the relay code
stays in the tree. But you cannot answer *"does this protocol actually work?"*
on browser seats — that needs ~100 questions x ~12 calls, which is impossible
inside a subscription quota and trivial on cheap API models.

---

## Step 1 — one key, four vendors (10 minutes)

[OpenRouter](https://openrouter.ai) is the fastest start: a single key reaches
OpenAI, Anthropic, Google and Meta models, so you get a genuinely heterogeneous
panel without four separate signups.

That heterogeneity is not cosmetic. Zhang et al. (2025) find model diversity is
the one reliable improvement to multi-agent debate, and that a panel of one base
model in several personas is exactly the configuration that underperforms. Four
labs is the configuration this design is built for.

Set the key in your shell:

```bash
setx OPENROUTER_API_KEY "sk-or-..."
```

Open a **new** terminal afterwards — `setx` does not affect the current one.

Then install the ready-made panel:

```bash
mkdir -p .data && cp examples/seats.openrouter.json .data/seats.json
```

Model IDs drift. If one is wrong the seat's health check will say so — it lists
what the endpoint actually offers. Adjust `.data/seats.json` and restart.

### Prefer direct keys?

Use `"adapter": "openai" | "anthropic" | "google"` with `apiKeyEnv` pointing at
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`. Slightly more setup,
no gateway in the middle, and per-provider rate-limit headers come through.

Keys are read from the environment by name. The config file stores the variable
name, never the value, so it is safe to copy or share.

---

## Step 2 — check the panel

```bash
npm run dev:engine
```

Then:

```bash
npm run conformance
```

Every seat should report reachable, answer `2+2` as `4`, and round-trip a LaTeX
fixture byte-for-byte. API seats normally pass all three — unlike browser seats,
there are no selectors to go stale.

---

## Step 3 — one real run

```bash
npm run dev:ui
```

http://127.0.0.1:5173 → ask something with a checkable answer:

> How many minutes are in one week?

Turn on **Self-check ×2** and **Cross-check** in the run bar. Both work properly
on API seats, so you get the full verification report: itemised confidence,
per-seat self-consistency, and a dissenter reviewing the agreed answer.

What to look for:

- if all four agreed immediately, the run stopped at round 1 without debating
- if they disagreed, watch the pruning — conceded critics drop out each round
- the confidence score is itemised, never a bare number

---

## Step 4 — the question the project rests on

```bash
npm run eval -- --real --sweep --limit 25
```

Start at 25 to see the cost, then scale up. The full 100-item set at ~12 calls
each is ~1,200 calls; on the cheap models above that is small money, and it is
the only way to answer this honestly.

**The number that matters is protocol vs self-consistency at matched compute**,
not protocol vs one model. Beating a single model while spending 12x the calls
proves nothing — self-consistency is the baseline the literature says usually
wins.

`--sweep` varies the agreement-modulation dial, which Smit et al. found was what
turned a losing protocol into a state-of-the-art one. If the protocol loses,
that is where to look first, then at whether your panel is genuinely diverse.

Record the result either way. A negative result on a real heterogeneous panel is
a genuine finding and worth more than an untested assumption.

---

## Step 5 — make it cheaper (optional)

Install [Ollama](https://ollama.com) and pull one mid-size model. A local seat
is unmetered, so it absorbs the extra debate rounds, and it lets the task
classifier and the LLM judge run for free. It is auto-discovered — nothing to
configure.

A mixed panel (three API seats plus one local) is the cheapest way to run the
protocol at depth.

---

## The browser relay, if you come back to it

Still in the tree, still tested, and the conformance suite is the way in. Two
things to know before you spend time on it:

- **Every selector in `.data/descriptors.json` is an unvalidated guess.** No
  descriptor has been tested against a live logged-in session. Expect red chips
  and use `POST /api/descriptors/:provider/heal` to propose repairs.
- **A seat needs a working pairing loop.** The offscreen document now retries
  and watches storage, so pasting the token wakes it. Load the extension, paste
  the token from `.data/relay-token`, and the badge should go green within a few
  seconds.

CDP is the lower-friction alternative — no extension, but it needs its own
Chrome profile, because Chrome 136+ ignores `--remote-debugging-port` on the
default one.

---

## What "finished" looks like

- [ ] `npm test` passes
- [ ] Four API seats from four different vendors, all passing conformance
- [ ] One real run converged, with a verification report you believe
- [ ] `npm run eval -- --real --sweep` run once, result recorded either way
- [ ] A local model added to absorb the rounds

The fourth item is the one that turns this from "it runs" into "it is worth
running".
