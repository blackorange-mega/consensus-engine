<!--
id: dispatch
description: Phase 1. Sent to every enabled seat in parallel, verbatim user prompt first.
variables: prompt, require_key, nonce
-->
{{prompt}}

---
Output only the answer. No preamble, no closing remarks, no commentary.
{{#require_key}}
Then, on a new line, add exactly one fenced block containing the bare claim
your answer makes — a number with units, a yes/no, a name, an identifier, a
short expression. No prose, no restatement of the question, no hedging:

```key
<bare claim>
```

If the question has no single bare claim, put a short canonical summary of
your position in the block instead.
{{/require_key}}
