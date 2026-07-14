# Immutable demo vault fixture

This fixture describes the no-cost onboarding preview. It demonstrates a continuous transcript, a source-linked architecture decision, a superseded decision, a contradiction, selected retrieval evidence, and a small graph. It is synthetic and MIT-licensed.

The application-owned demo representation is immutable at the product boundary. It must never share IDs, writes, jobs, cost, search indexes, or attachments with a personal vault. Leaving preview returns to the unchanged personal vault.

`manifest.json` provides a stable content description for release checks. UI fixture data may evolve only when the manifest version and checksum inputs are updated together.
