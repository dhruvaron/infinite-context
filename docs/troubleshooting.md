# Troubleshooting

## Node or pnpm version errors

Continuum requires Node 22 LTS.

```bash
nvm install 22
nvm use
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

If pnpm asks to replace an existing `node_modules`, use a normal interactive terminal and rerun installation. Do not mix dependencies installed by different Node major versions.

## macOS PDF/OCR helper is unavailable

Continuum compiles a small local PDFKit and Apple Vision helper from the checked-out source. Verify the required Command Line Tools and SDK before debugging an attachment:

```bash
xcode-select -p
pnpm test:native-ingestion
```

If `xcode-select -p` fails, run `xcode-select --install`, finish the Apple installer, and rerun the probe. The built-in bounded PDF fallback remains available, but image OCR and native PDF fidelity are degraded until this probe passes.

## The browser does not open

Run `pnpm start -- --no-open` and open the printed local URL only through the launch URL produced by the supervisor. A bare API URL has no authenticated session after each backend restart.

Check that a local firewall or another process is not blocking loopback. The supervisor normally chooses another available port.

## “Add an OpenAI API key”

Open Settings and save a valid key, or restart onboarding. The supported macOS path stores it in Keychain. To remove a development key manually, use Keychain Access and find the `dev.continuum.local` generic password.

Environment variables do not configure the normal application. `CONTINUUM_EVALUATION_OPENAI_API_KEY` is reserved for explicitly acknowledged paid evaluation commands, and the legacy `CONTINUUM_OPENAI_API_KEY` name is ignored by application configuration.

For no-cost testing, stop the app and restart with `CONTINUUM_MOCK_PROVIDER=true` and a disposable `CONTINUUM_DATA_DIR`.

## Provider errors or offline use

The raw submitted event should be committed before provider work. Local transcript browsing and search should remain available. Preserve the draft and retry only after inspecting status; repeated retries consume budget in live mode.

Do not confuse the temporary demo preview or mock provider with an offline copy of personal data. Demo content is a fixture.

## Memory is delayed or failed

The answer and post-turn memory compilation are separate. Inspect worker/job status. Failed jobs retry with backoff and eventually require manual retry. A missing memory update must not erase the completed answer.

Check the local logs directory under the configured data directory. Ordinary logs are redacted. Never paste an entire log or database into a public issue without checking for local paths and identifiers.

## Vector fallback is shown

Continuum normally auto-loads the `sqlite-vec` binary installed with the application. Open the developer diagnostics or request `/api/v1/health` from an authenticated local session and inspect:

- `database.vectorLoadStatus` — `ready` or `degraded`.
- `database.vectorStrategy` — native exact cosine or bounded JSON cosine.
- `database.vectorVersion` — the loaded extension version when ready.
- `database.vectorFallbackLimit` — the explicit degraded-mode row ceiling, currently 5,000 per embedding size and exact model.

In degraded mode, text and graph retrieval remain available, but vector search examines only the newest 5,000 canonical vectors whose dimensions and exact embedding model match the query. An older vector outside that bounded set can therefore be missed. Native and fallback search never mix models. Embedding jobs are also bound to the authoritative source generation, and a stale completion is discarded instead of replacing a newer vector. Retrieval traces identify the mode, examined/corpus row counts, and truncation. Retrieval-quality and scale results from fallback mode must be labeled separately from native `sqlite-vec` results.

For a normal source checkout, reinstall dependencies under Node 22 and restart before attempting a manual extension path. `CONTINUUM_SQLITE_VEC_EXTENSION` is only an optional development override for a compatible local extension binary. An incompatible architecture or SQLite build should remain visibly degraded rather than preventing transcript, text-search, or graph use.

## Embedding model change is refused

Continuum allows an embedding-model setting change only before the vault contains embeddable events, chunks, claims, active topics, vectors, or queued/running embedding work. Refusal after that point is intentional: silently changing the setting would mix incompatible vector spaces or make recall depend on migration timing. Keep the current model. A later-model transition is deferred until Continuum can show the complete estimated cost, rebuild the corpus resumably, and validate coverage before switching retrieval.

## Search or timeline scale issues

Run `pnpm load:quick` or `pnpm load:full` and inspect the JSON artifact. These commands use a temporary database and delete it unless the load script is passed `--keep-db`. Full mode may take materially longer and creates sparse logical attachment files.

## Playwright cannot find Chromium

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

The E2E harness uses API port 4317 and web port 4400 and deletes only `.continuum/playwright`. Stop another local process on either port before running.

## Resetting disposable development data

Stop all Continuum processes first. Remove only the disposable directory you explicitly passed in `CONTINUUM_DATA_DIR`. Never delete `~/Library/Application Support/Continuum` unless you intend to destroy the personal vault and have handled exports/backups.

## Reporting a security problem

Follow [SECURITY.md](../SECURITY.md). Do not place real keys, personal messages, attachments, or vault files in a public issue.
