# Continuum

Continuum is a local-first browser chat with one continuous timeline and an unbounded local memory layer. It stores retained events verbatim, compiles source-linked knowledge, and retrieves a bounded evidence packet for each finite-context model call.

“Infinite context” here does **not** mean that a model attends to the entire transcript at once. It means raw history remains locally addressable while relevant exact evidence, current topic pages, temporal claims, and graph relationships are paged into the model context.

Continuum v1 is a research prototype and college-scale open-source project. The repository contains substantial implementation and deterministic evidence tooling, but live benchmark and competitor results must not be inferred from the no-cost fixture report. See [Benchmarking](docs/benchmark.md) for the evidence boundary.

**Release status: NOT ACCEPTED.** The current source targets database schema 18. With locked dependencies restored under Node 22, this hardening tree passed all-workspace typecheck, root lint, contract coverage for 81 public routes across all 26 resource groups, conflict hygiene, the static security audit with 0 findings, 50 Vitest files with 470 tests, the production build, native Apple Vision/PDFKit ingestion smoke, the real macOS sandbox smoke, and all 26 executable Chromium/Firefox/WebKit journeys with 10 intentional browser-independent skips. The build emitted a non-fatal warning about a browser chunk larger than 500 kB. Commit `28e100a233c1428f0e1a78f99a56c66de8858dfd` also produced current schema-18 100k local-load and deterministic 10k no-cost artifacts with zero live calls and USD 0 cost; the deterministic run still misses the frozen 15% relative-accuracy gate at 8.7%. These artifacts are local/mock evidence, not live-provider, competitor, or product-superiority evidence. Recorded provider/API spend remains USD 0.00. See the [acceptance trace](docs/acceptance-trace.md) for the exact evidence boundary.

## Requirements

- macOS for the supported v1 path and Keychain integration.
- Xcode Command Line Tools with the macOS SDK (`xcode-select -p`). Continuum compiles its local PDFKit/Apple Vision helper from source; install the tools with `xcode-select --install` if the check fails.
- Node.js 22 LTS (`.nvmrc` is included).
- pnpm 11.7 through Corepack.
- An OpenAI API key for live responses. Mock mode requires no key or API credit.

## Start locally

```bash
nvm use
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm test:native-ingestion
pnpm start
```

The native-ingestion probe performs the real local compile and framework check. It spends no API credit and fails with a concrete setup error before a PDF or OCR job is queued.

The supervisor builds the browser UI, starts the loopback API and background worker, chooses an available local port, creates a fresh browser-session token, and opens the authenticated launch URL. Press `Ctrl+C` in the terminal to stop it.

For a terminal-only launch, use `pnpm start -- --no-open`. The supervisor prints a one-time authenticated launch URL; keep it private and paste that complete URL into a local browser.

On first launch, onboarding explains the local/provider data boundary and stores the API key in macOS Keychain. The key is not written to the browser, SQLite, logs, or portable exports.

The normal application deliberately has no API-key environment fallback: setting `CONTINUUM_OPENAI_API_KEY` or the evaluation credential does not configure chat or worker traffic. The dedicated `CONTINUUM_EVALUATION_OPENAI_API_KEY` variable is consumed only by paid evaluation commands after live/paid acknowledgements and durable budget admission pass.

### No-cost mock mode

Use a disposable data directory so mock evidence never mixes with a personal vault:

```bash
CONTINUUM_MOCK_PROVIDER=true \
CONTINUUM_DATA_DIR="$PWD/.continuum/mock" \
pnpm start
```

Mock mode exercises the local application and worker without calling OpenAI. Its answers and costs are test fixtures, not quality evidence.

## Development and verification

```bash
pnpm dev                 # API, worker, and Vite development UI
pnpm typecheck           # strict TypeScript across workspaces
pnpm lint                # repository lint
pnpm test                # Node and jsdom unit tests
pnpm build               # production workspace builds
pnpm test:e2e            # Playwright mock-mode browser journey
pnpm audit:security      # static local security checks
pnpm eval:no-cost        # deterministic four-mode + ablation report
pnpm eval:import-dataset # verify and locally normalize a user-downloaded public benchmark
pnpm eval:live           # dry-run/explicitly opted-in controlled paid response evaluation
pnpm eval:latency        # measure streamed-token and derived-memory searchability timing
pnpm eval:competitors    # validate/aggregate manually supplied black-box captures
pnpm load:quick          # 10k-event CI-friendly SQLite load evidence
pnpm load:full           # 100k events, 10k topics, 5 GiB sparse metadata
pnpm evidence:no-cost    # full local load, then linked no-cost report
```

Generated evidence is written under `artifacts/evaluation/`. A no-cost report always labels itself as a deterministic fixture and records zero live calls and zero provider spend.

## Repository map

```text
apps/web          React/Vite browser UI
apps/api          Fastify loopback API and SSE orchestration
apps/worker       durable background memory/ingestion worker
packages/         contracts, database, providers, memory, retrieval,
                  ingestion, tools, evaluation, observability, config
scripts/          supervisors, load evidence, security checks
tests/e2e         mock-provider Playwright journeys
fixtures/         immutable no-cost fixture material
docs/             architecture, privacy, memory, benchmark, and formats
```

## Documentation

- [Architecture](docs/architecture.md)
- [Privacy and data boundary](docs/privacy.md)
- [Memory model](docs/memory-model.md)
- [Benchmark and evidence protocol](docs/benchmark.md)
- [Portable vault interchange format](docs/interchange-format.md)
- [Testing](docs/testing.md)
- [V1 acceptance trace](docs/acceptance-trace.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Future coding-agent architecture](docs/future-coding-agent.md)
- [Security policy and threat model](SECURITY.md)
- [Binding implementation plan](IMPLEMENTATION_PLAN.md)

## Cost boundary

The project-wide implementation and final-evaluation budget is one non-renewable USD 100 lifetime allowance. Application and evaluation calls use the same cross-process atomic, machine-local ledger and reserve worst-case cost before network access; there is no second USD 100 allowance per vault, CLI, benchmark run, or user-authorized cycle. The product exposes no budget-reset operation. The budget view distinguishes spent, reserved, allocated, and available USD. Uncertain/expired requests are conservatively charged, and the non-portable ledger survives in-app vault deletion, replacement, and import. No live suite runs by default. See [Security policy and threat model](SECURITY.md#api-credit-cap) for provider-price and same-user trust limitations.

## License

[MIT](LICENSE)
