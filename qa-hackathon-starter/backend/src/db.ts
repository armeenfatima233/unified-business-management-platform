// Persistence layer (F1.1, Q6). Uses Node's built-in SQLite so the project needs no
// native build or separate DB server. All other modules go through `openDb`/`tx`,
// so swapping in PostgreSQL later (D01) only means replacing this file.
import { randomBytes } from "node:crypto";
import { backfillWorkspaces } from "./workspace/seed.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

// Schema is idempotent (IF NOT EXISTS) so it is safe to run on every start.
// Timestamps are stored as UTC ISO-8601 strings (D08).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,   -- stored lowercase
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- scrypt, never the plain password
  created_at    TEXT NOT NULL
);

-- A user belongs to a workspace through a membership. base_level is the fixed
-- Owner/Admin/User tier; Manager is permission-based and arrives with F1.3.
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  base_level   TEXT NOT NULL CHECK (base_level IN ('owner','admin','user')),
  availability TEXT NOT NULL DEFAULT 'available'
               CHECK (availability IN ('available','busy','on_leave','offline')),
  created_at   TEXT NOT NULL,
  removed_at   TEXT,                    -- soft removal keeps history (audit, closed leads) intact (Q4)
  PRIMARY KEY (workspace_id, user_id)
);

-- Only a SHA-256 hash of the session token is stored, so a leaked DB cannot be
-- used to hijack live sessions. Deleting the row revokes the session.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Per-member permission overrides on top of the base-level defaults (F1.3).
CREATE TABLE IF NOT EXISTS member_permissions (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  permission   TEXT NOT NULL,
  granted      INTEGER NOT NULL CHECK (granted IN (0,1)),
  PRIMARY KEY (workspace_id, user_id, permission),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);

-- Invitations (F1.2, D11 proposal): only a hash of the single-use token is stored.
CREATE TABLE IF NOT EXISTS invitations (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email        TEXT NOT NULL,
  base_level   TEXT NOT NULL CHECK (base_level IN ('admin','user')),
  invited_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_ws_email ON invitations(workspace_id, email);

-- Failed-login log, persisted so throttling survives a restart (Q1).
CREATE TABLE IF NOT EXISTS login_failures (
  key        TEXT NOT NULL,             -- "email|ip"
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures_key ON login_failures(key, created_at);

-- ===== CRM (F2). Every tenant table carries workspace_id, and cross-table foreign keys
-- include it, so a record can never point at another workspace's data (F1.6, Q2). =====
CREATE TABLE IF NOT EXISTS companies (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency (Q4)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  company_id       TEXT,
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  phone_normalized TEXT,                     -- digits with leading "+", used to match provider senders (I1.5)
  opt_out          INTEGER NOT NULL DEFAULT 0 CHECK (opt_out IN (0,1)),
  owner_id         TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES companies(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_ws_phone ON contacts(workspace_id, phone_normalized);
CREATE INDEX IF NOT EXISTS idx_contacts_ws_company ON contacts(workspace_id, company_id);

CREATE TABLE IF NOT EXISTS pipelines (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS stages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines(workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON stages(workspace_id, pipeline_id, position);

-- pipeline_id NULL = applies to every pipeline; otherwise only that pipeline (F2.3).
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_id  TEXT,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('contact','company','opportunity')),
  name         TEXT NOT NULL,
  field_type   TEXT NOT NULL CHECK (field_type IN ('text','number','date','dropdown','checkbox')),
  options      TEXT NOT NULL DEFAULT '[]',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines(workspace_id, id)
);

-- Moving an opportunity into this stage requires these fields to be filled (F2.4).
CREATE TABLE IF NOT EXISTS stage_required_fields (
  workspace_id TEXT NOT NULL,
  stage_id     TEXT NOT NULL,
  field_id     TEXT NOT NULL,
  PRIMARY KEY (stage_id, field_id),
  FOREIGN KEY (workspace_id, stage_id) REFERENCES stages(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, field_id) REFERENCES custom_field_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  workspace_id TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  field_id     TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (entity_id, field_id),
  FOREIGN KEY (workspace_id, field_id) REFERENCES custom_field_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opportunities (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  contact_id   TEXT NOT NULL,
  pipeline_id  TEXT NOT NULL,
  stage_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  value        REAL,                          -- field-level protected (F1.4)
  currency     TEXT NOT NULL DEFAULT 'USD',
  owner_id     TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)  REFERENCES contacts(workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines(workspace_id, id),
  FOREIGN KEY (workspace_id, stage_id)    REFERENCES stages(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id)    REFERENCES memberships(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_opps_ws_stage ON opportunities(workspace_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_opps_ws_contact ON opportunities(workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS activities (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  contact_id     TEXT NOT NULL,
  opportunity_id TEXT,
  type           TEXT NOT NULL,               -- note, stage_change, assignment, field_edit, message, payment, appointment, lead, ...
  text           TEXT NOT NULL,
  actor_id       TEXT,                        -- NULL = system
  created_at     TEXT NOT NULL,
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(workspace_id, contact_id, created_at);

CREATE TABLE IF NOT EXISTS saved_filters (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity       TEXT NOT NULL CHECK (entity IN ('contact','opportunity')),
  name         TEXT NOT NULL,
  criteria     TEXT NOT NULL,                 -- JSON; re-evaluated on every read so lists update automatically (F2.6)
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ===== Audit (F4). Append-only: triggers abort any UPDATE or DELETE. =====
CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id     TEXT,                          -- NULL = system
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ws_time ON audit_events(workspace_id, created_at);
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

-- ===== Leads (F3) =====
CREATE TABLE IF NOT EXISTS lead_routing_rules (
  workspace_id        TEXT PRIMARY KEY REFERENCES workspaces(id),
  ack_window_seconds  INTEGER NOT NULL DEFAULT 600,   -- configurable so a demo can use seconds
  max_open_leads      INTEGER NOT NULL DEFAULT 8,
  escalation_levels   INTEGER NOT NULL DEFAULT 3,     -- next employee, backup, manager
  idle_seconds        INTEGER NOT NULL DEFAULT 86400, -- recovery queue idle threshold (F3.7)
  level_window_seconds TEXT NOT NULL DEFAULT '[]',    -- optional per-level windows (JSON array of seconds)
  backup_user_id      TEXT,
  manager_user_id     TEXT,
  cursor_user_id      TEXT,                           -- round-robin position, durable fairness
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  contact_id          TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('web_form','message','manual')),
  message             TEXT,
  owner_id            TEXT NOT NULL,                  -- exactly one accountable owner (F3.8)
  assigned_at         TEXT NOT NULL,
  first_assigned_at   TEXT NOT NULL,
  deadline_at         TEXT,                           -- NULL once acknowledged
  acknowledged_at     TEXT,                           -- current owner's acknowledgement
  first_response_at   TEXT,                           -- first ever acknowledgement; never cleared (time to first response)
  closed_at           TEXT,                           -- NULL = open lead (counts toward capacity)
  escalation_count    INTEGER NOT NULL DEFAULT 0,
  level               INTEGER NOT NULL DEFAULT 0,
  handover_required   INTEGER NOT NULL DEFAULT 0 CHECK (handover_required IN (0,1)),
  attention_reason    TEXT,                           -- e.g. "No eligible employee" (D06)
  last_action_at      TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_due ON leads(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_ws_owner ON leads(workspace_id, owner_id);

CREATE TABLE IF NOT EXISTS lead_assignment_history (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  lead_id      TEXT NOT NULL,
  from_user_id TEXT,
  to_user_id   TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('intake','escalation','manual','absence','fallback')),
  created_at   TEXT NOT NULL,
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS dashboard_preferences (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  hidden       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (workspace_id, user_id)
);

-- ===== Integrations (I1-I5). Secrets are stored encrypted, never returned in full. =====
CREATE TABLE IF NOT EXISTS integration_connections (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  provider        TEXT NOT NULL CHECK (provider IN ('twilio','stripe','google','telegram','resend')),
  user_id         TEXT,                               -- set for per-employee connections (Google)
  status          TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','needs_reconnection')),
  config_json     TEXT NOT NULL DEFAULT '{}',         -- non-secret settings
  secrets_enc     TEXT,                               -- AES-256-GCM blob
  webhook_key     TEXT UNIQUE,                        -- unguessable path segment that routes provider webhooks to this workspace
  last_success_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_unique ON integration_connections(workspace_id, provider, ifnull(user_id, ''));

CREATE TABLE IF NOT EXISTS integration_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider     TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  event_type   TEXT NOT NULL,
  external_id  TEXT,
  result       TEXT NOT NULL CHECK (result IN ('ok','error','rejected','duplicate')),
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_events_ws ON integration_events(workspace_id, created_at);

-- Idempotency ledger: one row per provider event, so retries never repeat business effects (I1.8, I2.4, Q5).
CREATE TABLE IF NOT EXISTS processed_events (
  workspace_id TEXT NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider, external_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  last_message_at TEXT NOT NULL,
  unread          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, contact_id, channel),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  body                TEXT NOT NULL,
  provider_message_id TEXT,
  status              TEXT NOT NULL CHECK (status IN ('received','queued','sent','delivered','failed')),
  failure_reason      TEXT,
  retryable           INTEGER NOT NULL DEFAULT 0,       -- temporary provider failure: retried with a delay (I5.5)
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider ON messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  opportunity_id     TEXT NOT NULL,
  contact_id         TEXT NOT NULL,
  amount             INTEGER NOT NULL CHECK (amount > 0),   -- minor units (cents); never a card number (I2.8)
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','paid','failed','expired','refunded','partially_refunded')),
  refunded_amount    INTEGER NOT NULL DEFAULT 0,
  paid_at            TEXT,                                  -- set by the verified provider webhook
  requested_by       TEXT NOT NULL,
  provider_reference TEXT,                              -- Checkout Session id
  payment_intent     TEXT,
  payment_url        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ref ON payments(workspace_id, provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointments (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  opportunity_id  TEXT,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  starts_at       TEXT NOT NULL,                -- UTC
  ends_at         TEXT NOT NULL,                -- UTC
  timezone        TEXT NOT NULL,                -- IANA zone the employee booked in
  google_event_id TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  created_at      TEXT NOT NULL,
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_appts_user_time ON appointments(workspace_id, user_id, starts_at);

CREATE TABLE IF NOT EXISTS notification_destinations (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'telegram',
  destination  TEXT NOT NULL,                   -- Telegram chat id
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  lead_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  channel         TEXT NOT NULL,                -- 'email' (Resend, I4)
  reason          TEXT,                         -- why the alert was raised (shown in the message)
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_pending ON delivery_attempts(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state        TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // Without this SQLite silently ignores foreign keys.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Columns added after the first release; ALTER keeps existing databases working.
  ensureColumn(db, "workspaces", "public_key", "TEXT");
  ensureColumn(db, "memberships", "removed_at", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_public_key ON workspaces(public_key)");
  const missing = db.prepare("SELECT id FROM workspaces WHERE public_key IS NULL").all() as { id: string }[];
  for (const w of missing) db.prepare("UPDATE workspaces SET public_key = ? WHERE id = ?").run(randomBytes(16).toString("hex"), w.id);
  backfillWorkspaces(db);
  return db;
}

// Runs `fn` atomically: commit on success, roll back on any throw. Used so that
// signup never leaves a workspace without an Owner.
function ensureColumn(db: Db, table: string, column: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Re-entrant: inside an open transaction the work simply joins it, so a service can be called
// from a route that already holds the (serialising) write lock.
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
