# Public-dataset adapter fixtures

These tiny files exercise the published LongMemEval and HaluMem field layouts. Their prose and facts were written specifically for Continuum and are not copied, paraphrased, or sampled from either upstream dataset.

- `longmemeval.synthetic.sample.json` follows the official LongMemEval top-level JSON-array, session, turn, evidence-session, and question fields.
- `halumem.synthetic.sample.jsonl` follows the official HaluMem JSONL user, session, dialogue, memory-point, and question fields.
- `normalized.synthetic.sample.jsonl` is an unverified normalized record for no-call CLI dry-run tests.
- `manifest.json` records fixture hashes, origin, and redistribution status.

The fixtures test adapter compatibility only. They are not public-benchmark evidence and must never be included in a LongMemEval or HaluMem score.
