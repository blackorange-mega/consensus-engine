# Evidence base

Claims this project rests on, so they can be re-checked rather than taken on trust.

| Claim | Source | Status |
|---|---|---|
| Multi-agent debate does not reliably beat self-consistency or ensembling | [Smit et al., ICML 2024 — *Should we be going MAD?*](https://arxiv.org/abs/2311.17371) | Verified |
| MAD often fails to beat CoT / Self-Consistency across 9 benchmarks, at higher compute | [Zhang et al., 2025 — *Stop Overvaluing Multi-Agent Debate*](https://arxiv.org/abs/2502.08788) | Verified |
| **Model heterogeneity is a "universal antidote" that consistently improves MAD** | Zhang et al., same paper | Verified — and this design is heterogeneous by construction |
| Tuning agreement modulation took a weak MAD protocol to SOTA | Smit et al., same paper | Verified — drives the stubbornness setting |
| LLMs are systematically sycophantic; matching the interlocutor's view predicts preference | [Sharma et al., ICLR 2024](https://arxiv.org/abs/2310.13548) | Verified |
| Embedding cosine cannot separate contradiction from paraphrase | Measured on `potion-base-8M` | Measured — caveat: small static model |
| Call counts and wall-clock arithmetic | Derived from the protocol | Computed, and asserted in `protocol.test.ts` |
| Consumer subscription message caps | Secondary sources, Aug 2026 | **Approximate — re-verify, these change frequently** |
| Provider "Copy" buttons yield source markdown | Not verified | **Assumption — proven or disproven per provider by the conformance test** |

## What the pessimistic findings mean for this project

Two independent papers say multi-agent debate usually does not earn its compute. That is the single most
important thing to know before building on this protocol, so it is stated in the README rather than
buried.

The reason it is worth building anyway is narrow and specific: **nearly all MAD research runs one base
model in several personas**, and that is precisely the configuration Zhang et al. find underperforms.
They identify heterogeneity as the fix and argue the field should "actively embrace model heterogeneity
as a core design principle". A panel of four models from four different labs, with genuinely uncorrelated
training data and failure modes, is not the configuration those papers measured.

That is a plausible argument, not a proven result. Which is why the eval harness is step 0 of the build
order and not an afterthought.

## How to check it yourself

```bash
npm run eval -- --real --sweep
```

The number that matters is **protocol vs self-consistency at matched compute**, not protocol vs a single
model. Self-consistency is the baseline the literature says usually wins; beating one model while
spending 10× the calls proves nothing.

The harness reports:

- accuracy per condition, with calls per question alongside it
- **majority accuracy** — did the largest camp hold the right claim, even when the panel never reached
  unanimity
- **talked out of correct** — how often a correct round-1 answer was argued away, swept across
  agreement-modulation settings
- **rescued** — how often the debate found an answer no model had in round 1

If the delta against self-consistency is negative, the finding is that the protocol needs retuning. Sweep
the stubbornness dial first, then check panel heterogeneity. Shipping it anyway and hoping is the one
response the evidence does not support.
