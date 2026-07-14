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

## “The local vault could not be loaded completely”

Continuum requires every core bootstrap read—runtime, settings, budget, events, active runs, latest overall run state, topics, claims, and graph—to succeed between two matching server snapshot-boundary reads. The generation and vault ID must remain unchanged and maintenance must be unlocked. On first load, failure leaves an explicitly unavailable read-only shell; an empty timeline in that state is not evidence that the vault is empty. If a refresh fails after content was loaded, the last complete verified view stays visible but read-only. Search and Graph close and cannot issue vault reads until one stable canonical bootstrap succeeds. Use **Retry connection** after the API and worker are healthy. Do not reset or re-import merely to clear this state.

## “Add an OpenAI API key”

Open Settings and save a valid key, or restart onboarding. The supported macOS path stores it in Keychain. To remove a development key manually, use Keychain Access and find the `dev.continuum.local` generic password.

Environment variables do not configure the normal application. `CONTINUUM_EVALUATION_OPENAI_API_KEY` is reserved for explicitly acknowledged paid evaluation commands, and the legacy `CONTINUUM_OPENAI_API_KEY` name is ignored by application configuration.

For no-cost testing, stop the app and restart with `CONTINUUM_MOCK_PROVIDER=true` and a disposable `CONTINUUM_DATA_DIR`.

## Provider errors or offline use

The raw submitted event should be committed before provider work. If only the cloud provider fails while the loopback API remains healthy, local transcript browsing and search remain available. If the local API or canonical vault bootstrap is unavailable, the last verified view is read-only and Search/Graph are deliberately disabled until reconnect; this prevents a late request from repopulating a scrubbed vault. If the latest overall run is failed, its user-event parent survives reload even when no assistant event was created; **Retry response** is restored only when no active completed assistant answer already exists for that parent. Preserve the draft and retry only after inspecting status; repeated retries consume budget in live mode.

Do not confuse the temporary demo preview or mock provider with an offline copy of personal data. Demo content is a fixture. When leaving preview, Continuum first checks the canonical server boundary: it restores the exact pre-preview draft, settings, attachments, graph, and view state only when the personal vault generation and ID are unchanged. A changed or unavailable boundary scrubs the retained snapshot and requires reconnect instead of risking old-vault restoration.

## Memory is delayed or failed

The answer and post-turn memory compilation are separate. Inspect worker/job status. Failed jobs retry with backoff and eventually require manual retry. A missing memory update must not erase the completed answer.

Check the local logs directory under the configured data directory. Ordinary logs are redacted. Never paste an entire log or database into a public issue without checking for local paths and identifiers.

## A legacy memory proposal cannot be accepted

Pre-v2 proposals lack the exact claim, evidence, route, and candidate-content guards required for safe acceptance. Accept is intentionally refused. Reject the legacy proposal; the same transaction removes its isolated candidate material and queues protected-parent recompilation. The normalized replacement appears only after the durable worker job completes. Do not repeatedly attempt the unsafe accept action.

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

## Settings could not be saved

The settings dialog sends its changed fields as one validated, idempotent batch. If any field, alias collision, or embedding-corpus guard fails, none of the settings in that save are committed and the browser restores the prior values. Correct the reported field and submit the complete dialog again; do not assume that earlier fields in the form were partially applied. A successful response-model selection survives restart because startup seeds only missing provider presets rather than overwriting saved rows.

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

After an ordinary hard deletion commits, the browser cancels and invalidates streams; clears vault-scoped event, provenance, evidence, revision, retrieval, Search, and Graph state; advances its read scope; and performs a generation-stable canonical refetch. If that refetch fails, reconnect from the read-only state; the UI must not restore the pre-deletion snapshot. A success receipt followed by a temporarily empty/unavailable view is therefore different from a failed deletion, which leaves the impact dialog open and reports that nothing was deleted.

## Import committed or may have committed

If the import response is lost, Continuum deliberately clears the prior browser view and remains read-only. Wait for local maintenance to finish, then use **Retry connection**.

- `VAULT_IMPORT_RECOVERY_REQUIRED` means the replacement database committed but private-file, token, or projection finalization did not. Restart the local app. Startup completes the durable journal and publishes the exact response under the original idempotency identity before reopening mutations.
- `VAULT_IMPORT_ROLLBACK_RECOVERY_REQUIRED` means the database replacement rolled back but cleanup of staged private files did not finish. The old vault remains authoritative, but Continuum stays locked until restart finishes cleanup; then verify the bundle again before retrying if the prior verification token is no longer available.

A verified-import token is one-use and journal-owned. While prepared it returns `VERIFIED_IMPORT_IN_USE`; after a committed replacement it returns `VERIFIED_IMPORT_CONSUMED`. Do not submit the token under a new identity or create a parallel retry while recovery is pending.

## Reporting a security problem

Follow [SECURITY.md](../SECURITY.md). Do not place real keys, personal messages, attachments, or vault files in a public issue.
