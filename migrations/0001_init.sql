CREATE TABLE product_refs (
  slug         TEXT PRIMARY KEY,
  category     TEXT NOT NULL /* 'general' | 'general (built) / diy (kit)' | 'small' */,
  product_url  TEXT,
  body_md      TEXT NOT NULL /* the reference document, verbatim */,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL /* 'seed' | slack user id */
);

CREATE TABLE product_ref_aliases (
  alias_norm   TEXT PRIMARY KEY /* normalized by the resolver, see issue #8 */,
  slug         TEXT NOT NULL REFERENCES product_refs(slug) ON DELETE CASCADE
);
CREATE INDEX product_ref_aliases_slug ON product_ref_aliases(slug);

CREATE TABLE product_ref_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  body_md      TEXT NOT NULL,
  category     TEXT NOT NULL,
  product_url  TEXT,
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  source       TEXT NOT NULL /* 'seed' | 'authored' | 'refreshed' | 'restored' */,
  UNIQUE (slug, version)
);

CREATE TABLE ref_drafts (
  id            TEXT PRIMARY KEY /* crypto.randomUUID() */,
  slug          TEXT NOT NULL,
  body_md       TEXT NOT NULL,
  category      TEXT NOT NULL,
  product_url   TEXT,
  base_version  INTEGER /* NULL for a brand-new ref, else expected current version */,
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

CREATE TABLE slack_event_receipts (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);

CREATE TABLE jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL /* 'reply' | 'polish' | 'ref' */,
  channel_id       TEXT NOT NULL,
  thread_ts        TEXT NOT NULL,
  actor_user_id    TEXT NOT NULL,
  raw_text         TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  claim_token      TEXT,
  claim_expires_at INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX jobs_claimable ON jobs(state, claim_expires_at, id);

CREATE TABLE usage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT,
  task        TEXT NOT NULL /* 'compose' | 'author' | 'polish' */,
  provider    TEXT NOT NULL,
  model       TEXT,
  fallback    TEXT /* NULL on the happy path, else the reason token */,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  created_at  INTEGER NOT NULL
);
