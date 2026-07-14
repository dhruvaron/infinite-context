# Portable vault interchange format

## Purpose

A Continuum bundle is a versioned ZIP/ZIP64 for moving or archiving a vault. It is not a live database backup and never contains credentials, vector indexes, machine authorization, or executable work.

## Version 2 layout

```text
manifest.json
README.txt
data/tables/<portable-table>/<six-digit-shard>.jsonl
data/events/<six-digit-shard>.jsonl
wiki/<topic-id>.md
attachments/<sha256>                              # optional
```

The manifest records format version `2`, schema version, exact table counts, ordered table/event shard paths, attachment policy, expanded bytes, and a SHA-256 checksum and exact size for every payload entry. Table and human transcript JSONL are split before 32 MiB; one record may be at most 4 MiB. Attachments remain independently limited to 25 MiB. The aggregate transport and expanded-data cap is 6 GiB, chosen to cover the documented 5 GiB sparse load profile with bounded overhead.

Export writes table rows and transcript records directly to protected shard files, then streams those files and content-addressed attachments through a ZIP64 writer. Import streams the request to a `0700` staging directory, validates the central directory before expansion, expands each bounded member to disk, and loads JSONL one record at a time into an isolated, file-backed SQLite validation database. Neither direction constructs the archive or complete structured row set in memory. Legacy version-1 (`data/structured.json`) imports remain supported through the bounded compatibility reader.

Markdown and event JSONL are human-readable projections. Sharded table JSONL is the import source of truth. Every projection is regenerated from and compared with the validated tables before mutation.

## Privacy behavior

The default export excludes tool output. Exclusion follows every durable representation: `tool_executions`, role=`tool` call/result event content, and claims, entities, edges, and wiki pages tainted by that evidence. The original output is present only when the user explicitly enables sensitive tool output. Workspace roots, local paths, sessions, keys, pending/running work, leases, prompt traces, embeddings, and installation-level budget authority are never portable.

## Export retention and disk policy

Managed exports are retry artifacts, not permanent backups. Continuum retains a completed export for up to 24 hours, with at most three files and 12 GiB across the set; oldest/excess artifacts are pruned at startup, after creation, after downloads close, and during the background maintenance interval. A file actively being downloaded is never pruned. Reading does not extend its creation/mtime-based retry window. Health exposes snapshotting/archiving state plus expanded and written archive bytes. Before archive writing, Continuum requires room for the declared expanded payload plus 128 MiB and returns an explicit HTTP 507 error with required/available bytes when that safety margin is unavailable.

Import performs two conservative disk-admission checks. Before expansion it reserves the declared payload, file-backed validation/index overhead, and 256 MiB; before mutation it also reserves the mandatory safety backup, durable import-journal archive, and incoming CAS bytes. Either check fails with HTTP 507 and exact required/available byte counts before vault mutation. Temporary upload, verification, and journal files are private and are removed on success or failure.

Automatic daily/weekly backups use SQLite's online snapshot API and hard links to immutable CAS blobs. Long serialization runs against that private snapshot and does not take the live vault maintenance lock, so chat mutations remain writable. Automatic catch-up begins only after the socket is listening; its running/failed/completed state is exposed by health. Shutdown requests cooperative cancellation, waits at most two seconds for cleanup, and then continues. Every private snapshot directory carries an exact ownership marker; startup and hourly maintenance remove stale owned snapshots from dead processes while refusing symlinks, malformed/unowned directories, and plausibly active work.

## Hostile-import requirements

Before mutating the vault, the reader rejects oversized archives, unsafe or duplicate paths, directory members, unsupported compression/encryption, malformed ZIP/ZIP64 records, inconsistent local/central headers, CRC or SHA mismatches, non-canonical shard layouts, overlong records, invalid table columns/types/JSON, illegal portable settings/models, broken foreign keys, invalid attachment content addresses, inconsistent projections, schema mismatches, and budget ledgers above the installation cap. Verified attachment bytes are copied into the destination CAS and local paths are regenerated. Replace/fresh import then rebuilds indexes and derived work through trusted jobs.

Independent-vault merging remains outside V1. Version 1 is read-only compatibility; all new exports use version 2.
