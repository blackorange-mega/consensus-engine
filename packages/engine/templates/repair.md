<!--
id: repair
description: >
  One repair attempt after a malformed reply. A second failure
  marks the seat NON_COMPLIANT for the round and excludes it; it never crashes
  the run.
variables: expected_shape
-->
Your last reply did not match the required format.

Reply with only the verdict block, in exactly this shape, and nothing else —
no preamble, no explanation, no text outside the fence:

```verdict
{{expected_shape}}
```
