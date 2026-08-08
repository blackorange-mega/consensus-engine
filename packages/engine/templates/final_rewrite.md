<!--
id: final_rewrite
description: >
  Optional final step. Once the panel has converged, ask each
  seat to restate the agreed answer in full, well-structured form.
variables: original_prompt, agreed_answer, nonce
-->
The panel has converged. The agreed answer to the question below is given
after it.

<<<QUESTION nonce={{nonce}}
{{original_prompt}}
END QUESTION nonce={{nonce}}>>>

<<<AGREED_ANSWER nonce={{nonce}}
{{agreed_answer}}
END AGREED_ANSWER nonce={{nonce}}>>>

Write the agreed answer out in full, well-structured form, for the person who
asked the question. Preserve every substantive claim exactly as agreed — do not
add new claims, do not soften or strengthen any conclusion, do not introduce
caveats that were not part of the agreement.

Output only the answer. No preamble, no closing remarks, no commentary.
