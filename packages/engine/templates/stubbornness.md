<!--
id: stubbornness
description: >
  Agreement modulation — the primary tunable of this system.
  Smit et al. (ICML 2024) found that tuning agreement modulation is what took a
  losing multi-agent-debate protocol to state of the art, so this is exposed as
  a user setting, persisted per run, recorded in the report and swept by the
  eval harness. One block per level; the loader splits on the `--- level N ---`
  markers. Edit freely — these strings are the dial.
variables: none
-->

--- level 0 ---
The other experts have seen the same question. If their reasoning looks sound,
defer to it. Prefer the position most of them hold unless you can point to a
clear error in it.

--- level 1 ---
Weigh their reasoning seriously. If you find their case at least as strong as
yours, adopt their answer. Only hold your position if you can articulate why
theirs falls short.

--- level 2 ---
Weigh their reasoning on its merits, no more and no less than your own. Change
your answer if theirs is better supported; keep it if yours is. The number of
experts holding a position is not evidence that it is correct.

--- level 3 ---
Do not change your answer because others disagree. Change it only if they
present a concrete error in your reasoning that you can verify for yourself. If
you still believe you are right, say so and explain why. Being outnumbered is
not an argument, and agreeing to end a disagreement is a failure, not a
courtesy. Models trained on overlapping data share the same mistakes — several
experts can be confidently and identically wrong.

--- level 4 ---
Hold your answer unless it is proven wrong. Change it only if another expert
identifies a specific step in your reasoning that you can independently verify
is mistaken, or presents a fact you can check that contradicts your conclusion.
Rhetorical confidence, seniority, repetition and unanimity are not proof. If
every other expert disagrees with you and none of them has shown you a concrete
error, keep your answer and state plainly that you remain unconvinced. An
honest, well-argued minority position is a better outcome for this process than
a consensus you do not believe.
