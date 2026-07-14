# macOS Keychain stdin transport QA — 2026-07-14

Evidence class: **operator-observed local security diagnostic with a blocked final rerun**. No real credential or paid provider call was used.

## Earlier pre-final-hardening observation — passed and cleaned up

Before the final helper hardening in this worktree, an isolated synthetic lifecycle was observed with:

- service: `dev.continuum.local.qa-temporary`
- account: `prompt-transport-test`
- value: generated fake key-shaped data only; value intentionally not retained here
- set: the value was supplied to the Expect helper through stdin and was absent from the Expect and `security` argument lists
- read: Keychain lookup returned the same synthetic value
- delete: the temporary item was deleted successfully
- cleanup proof: a post-delete lookup returned item-not-found

This observation proves cleanup for that earlier helper revision only. It is not evidence that the final hardened helper completed an OS lifecycle.

## Final post-hardening OS lifecycle — BLOCKED, not claimed

The required final set/read/delete/post-delete rerun was requested after the helper changes below. The environment approval reviewer rejected macOS Keychain access because the account had reached its approval-usage limit and explicitly prohibited retrying or using an indirect workaround. The command did not execute, so this artifact makes **no final-helper OS lifecycle claim**.

Status: **BLOCKED pending a user-approved or manual rerun.**

## Final helper and wrapper hardening present in the worktree

- The normal application key is Keychain-only; application configuration no longer parses a provider-key environment fallback.
- Paid evaluation prechecks the distinct `CONTINUUM_EVALUATION_OPENAI_API_KEY` variable before creating a plan fence, then consumes it once only after durable budget admission, removes it from `process.env`, and passes an explicit in-memory test/live-only override.
- The Expect process receives `-N -n`, disabling system and per-user startup files before the helper executes.
- The helper disables session output, uses an absolute `/usr/bin/security` path, accepts only fixed-character service/account identifiers, and sends the secret only after one of the two expected password prompts.
- Helper stdin is capped by a 302-character read, requires exactly one trailing LF, and accepts only a maximum-300-character `sk-` key shape before spawning `security`.
- The Node wrapper uses a small allowlisted environment, bounded stdout/stderr, a 20-second outer timeout, graceful termination followed by a hard-kill fallback, and generic errors that do not include child output or stdin.

Automated coverage validates stdin-versus-argv separation, Expect startup-file suppression, malformed and oversized input rejection, exact single-LF parsing of `security -w` output with rejection of all other whitespace/data normalization, bounded subprocess output, environment filtering, timeout handling, helper source invariants, and a real macOS helper rejection path that exits before Keychain access.

## Required manual rerun against the final helper

Run from the repository root on macOS. Enter only a generated synthetic key-shaped value at the hidden prompt—never a real provider key. The `trap` attempts deletion on every shell exit path.

```zsh
SERVICE='dev.continuum.local.qa-temporary'
ACCOUNT='prompt-transport-test'
HELPER="$PWD/packages/providers/src/keychain-set.exp"

cleanup_keychain_qa() {
  /usr/bin/security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
  unset QA_KEY READ_BACK
}
trap cleanup_keychain_qa EXIT INT TERM

read -r -s 'QA_KEY?Enter a generated synthetic sk- value (never a real key): '
print
printf '%s\n' "$QA_KEY" | /usr/bin/expect -N -n "$HELPER" "$SERVICE" "$ACCOUNT"

READ_BACK="$(/usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w)"
[[ "$READ_BACK" == "$QA_KEY" ]] || { print -u2 'Synthetic read-back mismatch'; exit 1; }

/usr/bin/security delete-generic-password -s "$SERVICE" -a "$ACCOUNT"
unset READ_BACK QA_KEY

if /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w >/dev/null 2>&1; then
  print -u2 'Temporary Keychain item still exists after delete'
  exit 1
fi
print 'PASS: final helper set/read/delete completed and post-delete lookup is absent'
trap - EXIT INT TERM
```

Record only exit codes/booleans and the service/account identifiers. Do not retain the synthetic value or read-back output.

## Evidence boundary

Even after the pending synthetic rerun passes, it will establish only the isolated final helper transport and cleanup lifecycle. It is not a real-key validation, live OpenAI connectivity test, onboarding/browser proof, fresh-checkout proof, proof against a compromised same-user process, or evidence that any paid call was made.
