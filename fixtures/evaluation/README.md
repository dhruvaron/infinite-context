# Causal evaluation fixtures

`custom-normalized-manifest.synthetic.json` is a strict custom-source manifest for
`custom-normalized.synthetic.jsonl`. Both files contain only
locally authored synthetic smoke data; they contain no upstream benchmark records
and cannot establish a public-dataset or causal-performance claim.

Use them to exercise the no-cost production causal CLI and report pipeline:

```bash
pnpm --filter @continuum/evaluation evaluate:causal -- \
  --execute-no-cost \
  --custom-datasets fixtures/evaluation/custom-normalized.synthetic.jsonl \
  --custom-manifest fixtures/evaluation/custom-normalized-manifest.synthetic.json \
  --max-records 1 \
  --max-probes 1 \
  --repetitions 1 \
  --output artifacts/evaluation/causal/synthetic-smoke
```

The manifest deliberately marks no registry verification and does not convert this
fixture into release evidence.
