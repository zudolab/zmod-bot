/* Durable identity for the first authoritative rollback attempt. Only safe
   metadata is retained. Policy content, upstream responses, and credentials
   never enter this table. Additive-only, per CLAUDE.md. */
CREATE TABLE policy_rollback_attempts (
  job_id           INTEGER PRIMARY KEY NOT NULL CHECK (job_id > 0),
  path             TEXT NOT NULL CHECK (path = 'policy/reply-guidance.md'),
  target_version   INTEGER NOT NULL CHECK (target_version > 0),
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
