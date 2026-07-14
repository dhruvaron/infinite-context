# Manual black-box product captures

This directory contains a protocol and a blank capture template—not product results.

1. Copy `capture.template.json` next to the manually supplied transcript.
2. Change `status` to `complete`, fill the visible product metadata, enter human scores/rationales for every protocol scenario, and set all four attestations to `true` only when accurate. If a checkpoint was not reached or a metric cannot be scored, keep its metric values `null` and explain why in the rationale; do not delete the scenario entry.
3. Keep `protocolPath` pointed at the exact protocol used. Do not change it after capture.
4. Run `pnpm eval:competitors -- --capture path/to/capture.json`. Repeat `--capture` for additional products or repetitions.

The runner hashes the exact transcript and protocol bytes it reads, checks full checkpoint/scenario coverage, and aggregates only numeric scores that a human actually supplied. It rejects duplicate capture IDs, repeated transcript hashes, duplicate scenarios, and mixed protocol hashes so one observation cannot be accidentally weighted twice. Null values remain “not scored.” It does not sign in to, automate, scrape, infer hidden behavior from, or fabricate outcomes for ChatGPT or Codex.

Even matched visible model settings are not a causal comparison: the products' internal prompts, compaction, retrieval, routing, and token accounting are not observable or controlled.
