export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "canonical-vault-schema",
    sql: `
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE prompt_versions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        semantic_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        UNIQUE(name, semantic_version)
      ) STRICT;

      CREATE TABLE provider_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning_effort TEXT,
        parameters_json TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE budget_ledger (
        id TEXT PRIMARY KEY,
        model_call_id TEXT,
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL CHECK(estimated_cost_usd >= 0),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX budget_ledger_created_idx ON budget_ledger(created_at);

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        kind TEXT NOT NULL CHECK(kind IN ('message','tool_call','tool_result','attachment','cancellation','error','revision')),
        status TEXT NOT NULL CHECK(status IN ('pending','streaming','complete','incomplete','failed','excluded')),
        parent_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        run_id TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX events_sequence_idx ON events(sequence DESC);
      CREATE INDEX events_run_idx ON events(run_id);
      CREATE INDEX events_parent_idx ON events(parent_event_id);

      CREATE TABLE event_content (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        text_content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(event_id, ordinal)
      ) STRICT;

      CREATE TABLE assistant_revisions (
        id TEXT PRIMARY KEY,
        user_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        assistant_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(user_event_id, revision_number)
      ) STRICT;

      CREATE TABLE context_refs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        ref_type TEXT NOT NULL,
        ref_value TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX context_refs_event_idx ON context_refs(event_id);

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        uri TEXT,
        content_hash TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        freshness_class TEXT NOT NULL DEFAULT 'stable',
        created_at TEXT NOT NULL,
        retrieved_at TEXT
      ) STRICT;
      CREATE INDEX sources_hash_idx ON sources(content_hash);

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        storage_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','processing','ready','failed')),
        error_code TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX attachments_hash_idx ON attachments(content_hash);

      CREATE TABLE event_attachments (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        PRIMARY KEY(event_id, attachment_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE source_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        text_content TEXT NOT NULL,
        location_json TEXT NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, ordinal)
      ) STRICT;

      CREATE TABLE workspace_roots (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        authorized INTEGER NOT NULL CHECK(authorized IN (0, 1)),
        read_only INTEGER NOT NULL DEFAULT 1 CHECK(read_only IN (0, 1)),
        authorized_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE tool_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        output_text TEXT NOT NULL DEFAULT '',
        citations_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        sandbox_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX tool_executions_run_idx ON tool_executions(run_id);

      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        core_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        canonical_description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX entities_name_idx ON entities(normalized_name);

      CREATE TABLE entity_aliases (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        source_id TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(entity_id, normalized_alias)
      ) STRICT;
      CREATE INDEX entity_aliases_lookup_idx ON entity_aliases(normalized_alias);

      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        topic_id TEXT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        status TEXT NOT NULL CHECK(status IN ('current','superseded','conflicted','historical','expired')),
        source_role TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        observed_at TEXT NOT NULL,
        freshness_expires_at TEXT,
        extraction_version TEXT NOT NULL
      ) STRICT;
      CREATE INDEX claims_topic_idx ON claims(topic_id);
      CREATE INDEX claims_subject_idx ON claims(subject, predicate);

      CREATE TABLE claim_sources (
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('event','chunk','tool_result','user_edit')),
        excerpt_hash TEXT,
        PRIMARY KEY(claim_id, source_id, source_type)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE claim_relations (
        id TEXT PRIMARY KEY,
        source_claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        target_claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('supports','contradicts','refines','supersedes','derived_from','duplicate_of')),
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        created_at TEXT NOT NULL,
        UNIQUE(source_claim_id, target_claim_id, relation_type)
      ) STRICT;

      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'current',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        valid_from TEXT,
        valid_to TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, target_id, edge_type)
      ) STRICT;
      CREATE INDEX edges_source_idx ON edges(source_id);
      CREATE INDEX edges_target_idx ON edges(target_id);

      CREATE TABLE merge_history (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        reversed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE topic_pages (
        id TEXT PRIMARY KEY,
        core_type TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        active_revision INTEGER NOT NULL DEFAULT 1,
        scope_id TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_id, slug)
      ) STRICT;

      CREATE TABLE topic_page_revisions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topic_pages(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        current_state TEXT NOT NULL DEFAULT '',
        history TEXT NOT NULL DEFAULT '',
        open_questions_json TEXT NOT NULL DEFAULT '[]',
        generation_inputs_json TEXT NOT NULL DEFAULT '[]',
        author_type TEXT NOT NULL CHECK(author_type IN ('model','user','system')),
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(topic_id, revision_number)
      ) STRICT;

      CREATE TABLE page_section_sources (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES topic_page_revisions(id) ON DELETE CASCADE,
        section_key TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        claim_id TEXT,
        source_id TEXT NOT NULL
      ) STRICT;

      CREATE TABLE page_links (
        id TEXT PRIMARY KEY,
        source_topic_id TEXT NOT NULL REFERENCES topic_pages(id) ON DELETE CASCADE,
        target_topic_id TEXT NOT NULL REFERENCES topic_pages(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(source_topic_id, target_topic_id, relation_type)
      ) STRICT;

      CREATE TABLE vectors (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        embedding_version TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, source_type, model_id, content_hash)
      ) STRICT;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        maximum_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        result_json TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX jobs_claim_idx ON jobs(status, available_at, priority DESC);

      CREATE TABLE job_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        UNIQUE(job_id, attempt_number)
      ) STRICT;

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        user_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        assistant_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        quality TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','retrieving','streaming','complete','cancelled','failed')),
        cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0, 1)),
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX runs_status_idx ON runs(status, created_at);

      CREATE TABLE run_stream_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX run_stream_events_run_idx ON run_stream_events(run_id, id);

      CREATE TABLE model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        response_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        trace_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX model_calls_run_idx ON model_calls(run_id);

      CREATE TABLE retrieval_traces (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        classifications_json TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        selected_ids_json TEXT NOT NULL,
        token_budget_json TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX retrieval_traces_run_idx ON retrieval_traces(run_id);

      CREATE TABLE context_packets (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE memory_pins (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(object_type, object_id)
      ) STRICT;

      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE deletion_receipts (
        id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE backup_records (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('daily','weekly','manual')),
        checksum TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE event_fts USING fts5(event_id UNINDEXED, content, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, title, content, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE claim_fts USING fts5(claim_id UNINDEXED, subject, predicate, value, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE topic_fts USING fts5(topic_id UNINDEXED, title, content, tokenize='unicode61 remove_diacritics 2');

      CREATE TRIGGER event_content_ai AFTER INSERT ON event_content BEGIN
        INSERT INTO event_fts(event_id, content) VALUES (new.event_id, new.text_content);
      END;
      CREATE TRIGGER event_content_au AFTER UPDATE OF text_content ON event_content BEGIN
        DELETE FROM event_fts WHERE event_id = old.event_id;
        INSERT INTO event_fts(event_id, content)
          SELECT event_id, group_concat(text_content, '\n') FROM event_content WHERE event_id = new.event_id GROUP BY event_id;
      END;
      CREATE TRIGGER event_content_ad AFTER DELETE ON event_content BEGIN
        DELETE FROM event_fts WHERE event_id = old.event_id;
        INSERT INTO event_fts(event_id, content)
          SELECT event_id, group_concat(text_content, '\n') FROM event_content WHERE event_id = old.event_id GROUP BY event_id;
      END;
      CREATE TRIGGER source_chunks_ai AFTER INSERT ON source_chunks BEGIN
        INSERT INTO chunk_fts(chunk_id, title, content)
          SELECT new.id, sources.title, new.text_content FROM sources WHERE sources.id = new.source_id;
      END;
      CREATE TRIGGER source_chunks_ad AFTER DELETE ON source_chunks BEGIN
        DELETE FROM chunk_fts WHERE chunk_id = old.id;
      END;
      CREATE TRIGGER claims_ai AFTER INSERT ON claims BEGIN
        INSERT INTO claim_fts(claim_id, subject, predicate, value) VALUES (new.id, new.subject, new.predicate, new.value);
      END;
      CREATE TRIGGER claims_au AFTER UPDATE ON claims BEGIN
        DELETE FROM claim_fts WHERE claim_id = old.id;
        INSERT INTO claim_fts(claim_id, subject, predicate, value) VALUES (new.id, new.subject, new.predicate, new.value);
      END;
      CREATE TRIGGER claims_ad AFTER DELETE ON claims BEGIN
        DELETE FROM claim_fts WHERE claim_id = old.id;
      END;
      CREATE TRIGGER topic_revisions_ai AFTER INSERT ON topic_page_revisions BEGIN
        DELETE FROM topic_fts WHERE topic_id = new.topic_id;
        INSERT INTO topic_fts(topic_id, title, content)
          SELECT new.topic_id, topic_pages.title, new.markdown FROM topic_pages WHERE topic_pages.id = new.topic_id;
      END;
    `
  },
  {
    version: 2,
    name: "deletion-budget-and-index-integrity",
    sql: `
      CREATE TABLE budget_reservations (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        category TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL CHECK(estimated_cost_usd >= 0),
        status TEXT NOT NULL CHECK(status IN ('reserved','settled','released')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        settled_at TEXT
      ) STRICT;
      CREATE INDEX budget_reservations_status_idx ON budget_reservations(status, expires_at);

      CREATE TABLE deletion_operations (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('prepared','database_complete','files_complete','complete','failed')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER topic_pages_ad AFTER DELETE ON topic_pages BEGIN
        DELETE FROM topic_fts WHERE topic_id = old.id;
      END;
      CREATE TRIGGER topic_pages_au AFTER UPDATE OF title ON topic_pages BEGIN
        DELETE FROM topic_fts WHERE topic_id = old.id;
        INSERT INTO topic_fts(topic_id, title, content)
          SELECT new.id, new.title, topic_page_revisions.markdown
          FROM topic_page_revisions
          WHERE topic_page_revisions.topic_id = new.id
            AND topic_page_revisions.revision_number = new.active_revision;
      END;
      CREATE TRIGGER topic_revisions_ad AFTER DELETE ON topic_page_revisions BEGIN
        DELETE FROM topic_fts WHERE topic_id = old.topic_id;
        INSERT INTO topic_fts(topic_id, title, content)
          SELECT topic_pages.id, topic_pages.title, topic_page_revisions.markdown
          FROM topic_pages JOIN topic_page_revisions ON topic_page_revisions.topic_id = topic_pages.id
          WHERE topic_pages.id = old.topic_id
            AND topic_page_revisions.revision_number = topic_pages.active_revision;
      END;
    `
  },
  {
    version: 3,
    name: "logical-attachments-over-deduplicated-bytes",
    sql: `
      DROP INDEX IF EXISTS attachments_hash_idx;
      CREATE INDEX attachments_hash_idx ON attachments(content_hash);
    `
  },
  {
    version: 4,
    name: "historical-topic-revision-search",
    sql: `
      CREATE VIRTUAL TABLE topic_revision_fts USING fts5(
        revision_id UNINDEXED, topic_id UNINDEXED, title, content,
        tokenize='unicode61 remove_diacritics 2'
      );
      INSERT INTO topic_revision_fts(revision_id, topic_id, title, content)
        SELECT tpr.id, tpr.topic_id, tp.title, tpr.markdown
        FROM topic_page_revisions tpr JOIN topic_pages tp ON tp.id = tpr.topic_id;
      CREATE TRIGGER topic_revisions_history_ai AFTER INSERT ON topic_page_revisions BEGIN
        INSERT INTO topic_revision_fts(revision_id, topic_id, title, content)
          SELECT new.id, new.topic_id, topic_pages.title, new.markdown FROM topic_pages WHERE topic_pages.id = new.topic_id;
      END;
      CREATE TRIGGER topic_revisions_history_ad AFTER DELETE ON topic_page_revisions BEGIN
        DELETE FROM topic_revision_fts WHERE revision_id = old.id;
      END;
      CREATE TRIGGER topic_pages_history_title_au AFTER UPDATE OF title ON topic_pages BEGIN
        DELETE FROM topic_revision_fts WHERE topic_id = old.id;
        INSERT INTO topic_revision_fts(revision_id, topic_id, title, content)
          SELECT tpr.id, new.id, new.title, tpr.markdown FROM topic_page_revisions tpr WHERE tpr.topic_id = new.id;
      END;
    `
  },
  {
    version: 5,
    name: "durable-import-journal",
    sql: `
      CREATE TABLE import_operations (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('replace','fresh')),
        archive_checksum TEXT NOT NULL,
        archive_filename TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK(phase IN ('prepared','database_complete','files_complete','complete','failed')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX import_operations_recovery_idx ON import_operations(phase, created_at);
    `
  },
  {
    version: 6,
    name: "operation-scoped-idempotency-keys",
    sql: `
      CREATE TABLE idempotency_keys_v2 (
        key TEXT NOT NULL,
        operation TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(key, operation)
      ) STRICT, WITHOUT ROWID;

      INSERT INTO idempotency_keys_v2(key, operation, response_json, created_at)
        SELECT key, operation, response_json, created_at FROM idempotency_keys;
      DROP TABLE idempotency_keys;
      ALTER TABLE idempotency_keys_v2 RENAME TO idempotency_keys;
    `
  },
  {
    version: 7,
    name: "installation-budget-guard",
    sql: `
      CREATE TABLE installation_budget_ledger (
        id TEXT PRIMARY KEY,
        reservation_id TEXT UNIQUE,
        model_call_id TEXT,
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
        estimated_cost_usd REAL NOT NULL CHECK(estimated_cost_usd >= 0),
        accounting_status TEXT NOT NULL CHECK(accounting_status IN ('actual','conservative')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX installation_budget_created_idx ON installation_budget_ledger(created_at);
      CREATE INDEX installation_budget_category_idx ON installation_budget_ledger(category);

      INSERT INTO installation_budget_ledger(
        id, reservation_id, model_call_id, category, provider, model,
        input_tokens, output_tokens, estimated_cost_usd, accounting_status, created_at
      )
      SELECT id, NULL, model_call_id, category, provider, model,
        input_tokens, output_tokens, estimated_cost_usd, 'actual', created_at
      FROM budget_ledger;

      ALTER TABLE budget_reservations
        ADD COLUMN hard_limit_usd REAL NOT NULL DEFAULT 100
        CHECK(hard_limit_usd > 0 AND hard_limit_usd <= 100);
    `
  },
  {
    version: 8,
    name: "vector-dimension-index",
    sql: `
      CREATE INDEX vectors_dimensions_created_idx
        ON vectors(dimensions, created_at DESC, id ASC);
    `
  },
  {
    version: 9,
    name: "bounded-graph-adjacency-indexes",
    sql: `
      CREATE INDEX edges_source_created_idx
        ON edges(source_id, created_at DESC, id ASC);
      CREATE INDEX edges_target_created_idx
        ON edges(target_id, created_at DESC, id ASC);
      CREATE INDEX claims_topic_observed_idx
        ON claims(topic_id, observed_at DESC, id ASC);
    `
  },
  {
    version: 10,
    name: "auditable-context-and-source-derivations",
    sql: `
      ALTER TABLE context_packets
        ADD COLUMN rendered_content TEXT NOT NULL DEFAULT '';

      ALTER TABLE source_chunks
        ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE source_chunks
        ADD COLUMN chunker_version TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE source_chunks
        ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
    `
  },
  {
    version: 11,
    name: "reference-only-context-packets",
    sql: `
      ALTER TABLE context_packets
        ADD COLUMN composition_json TEXT NOT NULL DEFAULT '{}';

      -- Context packets are an audit index, not a second content store. Older
      -- development builds briefly wrote the rendered memory body here; scrub
      -- it during migration and reconstruct future packets from immutable
      -- source references when the user opens answer diagnostics.
      UPDATE context_packets SET rendered_content = '';
    `
  },
  {
    version: 12,
    name: "complete-focused-graph-adjacency-indexes",
    sql: `
      CREATE INDEX claim_sources_source_idx
        ON claim_sources(source_id, claim_id);
      CREATE INDEX claim_relations_source_created_idx
        ON claim_relations(source_claim_id, created_at DESC, id ASC);
      CREATE INDEX claim_relations_target_created_idx
        ON claim_relations(target_claim_id, created_at DESC, id ASC);
      CREATE INDEX page_links_source_created_idx
        ON page_links(source_topic_id, created_at DESC, id ASC);
      CREATE INDEX page_links_target_created_idx
        ON page_links(target_topic_id, created_at DESC, id ASC);
      CREATE INDEX attachments_source_created_idx
        ON attachments(source_id, created_at DESC, id ASC);
      CREATE INDEX page_section_sources_source_idx
        ON page_section_sources(source_id, revision_id);
    `
  },
  {
    version: 13,
    name: "indexed-claim-slot-compilation",
    sql: `
      -- The worker's temporal reconciler compares normalized subject/predicate
      -- slots.  The common case is already normalized by structured extraction;
      -- this expression index makes that lookup independent of ledger size.
      -- Unusual Unicode/inner-whitespace variants are still checked by the
      -- worker's correctness-preserving fallback.
      CREATE INDEX claims_normalized_slot_status_idx
        ON claims(lower(trim(subject)), lower(trim(predicate)), status, observed_at DESC, id ASC);
    `
  },
  {
    version: 14,
    name: "exact-normalized-claim-slot-index",
    sql: `
      -- SQLite's lower()/trim() expression index cannot reproduce the
      -- compiler's Unicode NFKC and inner-whitespace normalization. Keep the
      -- exact keys in a narrow companion table populated by application code;
      -- triggers give direct SQL imports a conservative baseline until the
      -- one-time application normalization pass repairs them.
      CREATE TABLE claim_slot_index (
        claim_id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
        subject_key TEXT NOT NULL,
        predicate_key TEXT NOT NULL,
        topic_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('current','superseded','conflicted','historical','expired')),
        active_evidence INTEGER NOT NULL DEFAULT 0 CHECK(active_evidence IN (0, 1))
      ) STRICT;
      CREATE INDEX claim_slot_lookup_idx
        ON claim_slot_index(subject_key, predicate_key, topic_id, status, active_evidence, claim_id);

      CREATE TABLE claim_slot_topics (
        subject_key TEXT NOT NULL,
        predicate_key TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        claim_count INTEGER NOT NULL CHECK(claim_count >= 0),
        active_claim_count INTEGER NOT NULL CHECK(active_claim_count >= 0),
        PRIMARY KEY(subject_key, predicate_key, topic_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX claim_slot_topics_active_idx
        ON claim_slot_topics(subject_key, predicate_key, active_claim_count, topic_id);

      CREATE TABLE claim_slot_index_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        normalization_version INTEGER NOT NULL CHECK(normalization_version >= 0)
      ) STRICT;
      INSERT INTO claim_slot_index_state(id, normalization_version) VALUES (1, 0);

      CREATE TRIGGER claim_slot_topics_ai AFTER INSERT ON claim_slot_index
      WHEN new.topic_id IS NOT NULL BEGIN
        INSERT INTO claim_slot_topics(subject_key, predicate_key, topic_id, claim_count, active_claim_count)
        VALUES (new.subject_key, new.predicate_key, new.topic_id, 1,
          CASE WHEN new.active_evidence = 1 AND new.status IN ('current','conflicted') THEN 1 ELSE 0 END)
        ON CONFLICT(subject_key, predicate_key, topic_id) DO UPDATE SET
          claim_count = claim_count + 1,
          active_claim_count = active_claim_count + excluded.active_claim_count;
      END;
      CREATE TRIGGER claim_slot_topics_ad AFTER DELETE ON claim_slot_index
      WHEN old.topic_id IS NOT NULL BEGIN
        UPDATE claim_slot_topics SET
          claim_count = claim_count - 1,
          active_claim_count = active_claim_count - CASE
            WHEN old.active_evidence = 1 AND old.status IN ('current','conflicted') THEN 1 ELSE 0 END
        WHERE subject_key = old.subject_key AND predicate_key = old.predicate_key AND topic_id = old.topic_id;
        DELETE FROM claim_slot_topics
        WHERE subject_key = old.subject_key AND predicate_key = old.predicate_key AND topic_id = old.topic_id AND claim_count = 0;
      END;
      CREATE TRIGGER claim_slot_topics_au AFTER UPDATE OF subject_key, predicate_key, topic_id, status, active_evidence ON claim_slot_index BEGIN
        UPDATE claim_slot_topics SET
          claim_count = claim_count - 1,
          active_claim_count = active_claim_count - CASE
            WHEN old.active_evidence = 1 AND old.status IN ('current','conflicted') THEN 1 ELSE 0 END
        WHERE old.topic_id IS NOT NULL AND subject_key = old.subject_key AND predicate_key = old.predicate_key AND topic_id = old.topic_id;
        DELETE FROM claim_slot_topics
        WHERE old.topic_id IS NOT NULL AND subject_key = old.subject_key AND predicate_key = old.predicate_key AND topic_id = old.topic_id AND claim_count = 0;
        INSERT INTO claim_slot_topics(subject_key, predicate_key, topic_id, claim_count, active_claim_count)
        SELECT new.subject_key, new.predicate_key, new.topic_id, 1,
          CASE WHEN new.active_evidence = 1 AND new.status IN ('current','conflicted') THEN 1 ELSE 0 END
        WHERE new.topic_id IS NOT NULL
        ON CONFLICT(subject_key, predicate_key, topic_id) DO UPDATE SET
          claim_count = claim_count + 1,
          active_claim_count = active_claim_count + excluded.active_claim_count;
      END;

      INSERT INTO claim_slot_index(claim_id, subject_key, predicate_key, topic_id, status, active_evidence)
        SELECT c.id, lower(trim(c.subject)), lower(trim(c.predicate)), c.topic_id, c.status,
          CASE WHEN EXISTS (
            SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
            WHERE cs.claim_id = c.id AND (e.id IS NULL OR e.active = 1)
          ) THEN 1 ELSE 0 END
        FROM claims c;

      CREATE TRIGGER claims_slot_index_ai AFTER INSERT ON claims BEGIN
        INSERT INTO claim_slot_index(claim_id, subject_key, predicate_key, topic_id, status, active_evidence)
        VALUES (new.id, lower(trim(new.subject)), lower(trim(new.predicate)), new.topic_id, new.status, 0)
        ON CONFLICT(claim_id) DO UPDATE SET
          subject_key = excluded.subject_key,
          predicate_key = excluded.predicate_key,
          topic_id = excluded.topic_id,
          status = excluded.status;
      END;
      CREATE TRIGGER claims_slot_index_au AFTER UPDATE OF subject, predicate, topic_id, status ON claims BEGIN
        INSERT INTO claim_slot_index(claim_id, subject_key, predicate_key, topic_id, status, active_evidence)
        VALUES (new.id, lower(trim(new.subject)), lower(trim(new.predicate)), new.topic_id, new.status,
          COALESCE((SELECT active_evidence FROM claim_slot_index WHERE claim_id = new.id), 0))
        ON CONFLICT(claim_id) DO UPDATE SET
          subject_key = excluded.subject_key,
          predicate_key = excluded.predicate_key,
          topic_id = excluded.topic_id,
          status = excluded.status;
      END;
      CREATE TRIGGER claim_sources_slot_index_ai AFTER INSERT ON claim_sources BEGIN
        UPDATE claim_slot_index SET active_evidence = CASE WHEN EXISTS (
          SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
          WHERE cs.claim_id = new.claim_id AND (e.id IS NULL OR e.active = 1)
        ) THEN 1 ELSE 0 END WHERE claim_id = new.claim_id;
      END;
      CREATE TRIGGER claim_sources_slot_index_ad AFTER DELETE ON claim_sources BEGIN
        UPDATE claim_slot_index SET active_evidence = CASE WHEN EXISTS (
          SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
          WHERE cs.claim_id = old.claim_id AND (e.id IS NULL OR e.active = 1)
        ) THEN 1 ELSE 0 END WHERE claim_id = old.claim_id;
      END;
      CREATE TRIGGER events_slot_index_active_au AFTER UPDATE OF active ON events BEGIN
        UPDATE claim_slot_index SET active_evidence = CASE WHEN EXISTS (
          SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
          WHERE cs.claim_id = claim_slot_index.claim_id AND (e.id IS NULL OR e.active = 1)
        ) THEN 1 ELSE 0 END
        WHERE claim_id IN (SELECT claim_id FROM claim_sources WHERE source_id = new.id);
      END;
    `
  },
  {
    version: 15,
    name: "incremental-topic-projection-indexes",
    sql: `
      CREATE INDEX page_section_sources_revision_section_claim_source_idx
        ON page_section_sources(revision_id, section_key, claim_id, source_id);
      CREATE INDEX page_section_sources_claim_section_revision_idx
        ON page_section_sources(claim_id, section_key, revision_id);
      CREATE INDEX claims_topic_status_observed_cover_idx
        ON claims(topic_id, status, observed_at DESC, id ASC);

      CREATE TABLE topic_projection_state (
        parent_topic_id TEXT PRIMARY KEY REFERENCES topic_pages(id) ON DELETE CASCADE,
        layout_version INTEGER NOT NULL CHECK(layout_version > 0),
        mode TEXT NOT NULL CHECK(mode IN ('inline','sharded')),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE topic_section_shards (
        child_topic_id TEXT PRIMARY KEY REFERENCES topic_pages(id) ON DELETE CASCADE,
        parent_topic_id TEXT NOT NULL REFERENCES topic_pages(id) ON DELETE CASCADE,
        section_key TEXT NOT NULL CHECK(section_key IN ('overview','current_state','history','evidence')),
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        min_sort_key TEXT NOT NULL,
        max_sort_key TEXT NOT NULL,
        UNIQUE(parent_topic_id, section_key, ordinal)
      ) STRICT;
      CREATE INDEX topic_section_shards_range_idx
        ON topic_section_shards(parent_topic_id, section_key, max_sort_key, ordinal);
      CREATE INDEX topic_section_shards_tail_idx
        ON topic_section_shards(parent_topic_id, section_key, ordinal DESC);

      CREATE TABLE topic_projection_dirty (
        parent_topic_id TEXT NOT NULL REFERENCES topic_pages(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY(parent_topic_id, claim_id)
      ) STRICT, WITHOUT ROWID;
    `
  },
  {
    version: 16,
    name: "protected-sharded-topic-proposals",
    sql: `
      ALTER TABLE topic_pages ADD COLUMN update_policy TEXT NOT NULL DEFAULT 'automatic'
        CHECK(update_policy IN ('automatic','confirm'));
      UPDATE topic_pages SET update_policy = 'confirm'
      WHERE EXISTS (
        SELECT 1 FROM topic_page_revisions revision
        WHERE revision.topic_id = topic_pages.id
          AND revision.author_type = 'user'
      );

      CREATE TABLE topic_shard_proposals (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        parent_topic_id TEXT NOT NULL REFERENCES topic_pages(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        parent_revision_id TEXT NOT NULL,
        parent_revision INTEGER NOT NULL CHECK(parent_revision > 0),
        parent_fingerprint TEXT NOT NULL,
        claim_ids_json TEXT NOT NULL DEFAULT '[]',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded','stale')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX topic_shard_proposals_pending_idx
        ON topic_shard_proposals(status, created_at DESC, id DESC);
      CREATE INDEX topic_shard_proposals_parent_pending_idx
        ON topic_shard_proposals(parent_topic_id, status, created_at DESC);

      CREATE TABLE topic_shard_proposal_patches (
        proposal_id TEXT NOT NULL REFERENCES topic_shard_proposals(id) ON DELETE CASCADE,
        patch_index INTEGER NOT NULL CHECK(patch_index >= 0),
        section_key TEXT NOT NULL CHECK(section_key IN ('current_state','history','evidence')),
        base_topic_id TEXT,
        base_revision_id TEXT,
        base_revision INTEGER CHECK(base_revision > 0),
        base_ordinal INTEGER CHECK(base_ordinal > 0),
        base_min_sort_key TEXT,
        base_max_sort_key TEXT,
        base_fingerprint TEXT,
        PRIMARY KEY(proposal_id, patch_index),
        CHECK(
          (base_topic_id IS NULL AND base_revision_id IS NULL AND base_revision IS NULL
            AND base_ordinal IS NULL AND base_min_sort_key IS NULL
            AND base_max_sort_key IS NULL AND base_fingerprint IS NULL)
          OR
          (base_topic_id IS NOT NULL AND base_revision_id IS NOT NULL AND base_revision IS NOT NULL
            AND base_ordinal IS NOT NULL AND base_min_sort_key IS NOT NULL
            AND base_max_sort_key IS NOT NULL AND base_fingerprint IS NOT NULL)
        )
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX topic_shard_proposal_patches_base_idx
        ON topic_shard_proposal_patches(base_topic_id, section_key, proposal_id);

      CREATE TABLE topic_shard_proposal_routes (
        proposal_id TEXT NOT NULL,
        patch_index INTEGER NOT NULL,
        route_index INTEGER NOT NULL CHECK(route_index >= 0),
        claim_id TEXT NOT NULL,
        sort_key TEXT NOT NULL,
        expected_base_topic_id TEXT,
        PRIMARY KEY(proposal_id, patch_index, route_index),
        FOREIGN KEY(proposal_id, patch_index)
          REFERENCES topic_shard_proposal_patches(proposal_id, patch_index) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE topic_shard_proposal_outputs (
        proposal_id TEXT NOT NULL,
        patch_index INTEGER NOT NULL,
        output_index INTEGER NOT NULL CHECK(output_index >= 0),
        topic_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK(revision_number > 0),
        base_revision INTEGER CHECK(base_revision > 0),
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        min_sort_key TEXT NOT NULL,
        max_sort_key TEXT NOT NULL,
        claim_ids_json TEXT NOT NULL DEFAULT '[]',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        PRIMARY KEY(proposal_id, patch_index, output_index),
        UNIQUE(proposal_id, topic_id, revision_id),
        FOREIGN KEY(proposal_id, patch_index)
          REFERENCES topic_shard_proposal_patches(proposal_id, patch_index) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX topic_shard_proposal_outputs_ordinal_idx
        ON topic_shard_proposal_outputs(ordinal, proposal_id);

      CREATE TABLE topic_shard_proposal_claim_guards (
        proposal_id TEXT NOT NULL REFERENCES topic_shard_proposals(id) ON DELETE CASCADE,
        guard_index INTEGER NOT NULL CHECK(guard_index >= 0),
        claim_id TEXT NOT NULL,
        expected_topic_id TEXT,
        state_hash TEXT NOT NULL,
        projected_topic_id TEXT,
        assign_to_topic_id TEXT,
        PRIMARY KEY(proposal_id, guard_index),
        UNIQUE(proposal_id, claim_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX topic_shard_proposal_claim_guards_claim_idx
        ON topic_shard_proposal_claim_guards(claim_id, proposal_id);
    `
  },
  {
    version: 17,
    name: "versioned-dirty-topic-projections",
    sql: `
      ALTER TABLE topic_projection_dirty
        ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0);
      ALTER TABLE topic_projection_dirty
        ADD COLUMN repair_token TEXT NOT NULL DEFAULT '';
      UPDATE topic_projection_dirty
        SET repair_token = lower(hex(randomblob(16))) WHERE repair_token = '';
      CREATE INDEX topic_projection_dirty_oldest_idx
        ON topic_projection_dirty(first_seen_at, parent_topic_id, claim_id, generation, repair_token);
    `
  }
];
