PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS oidc_states (
  state_hash TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  issuer TEXT NOT NULL,
  redirect_target TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS used_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  course_context TEXT NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_course ON links(deployment_id, course_context);
CREATE TABLE IF NOT EXISTS identities (
  deployment_id TEXT NOT NULL,
  course_context TEXT NOT NULL,
  subject TEXT NOT NULL,
  name TEXT,
  email TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(deployment_id, course_context, subject)
);
CREATE TABLE IF NOT EXISTS assignments (
  pool_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  course_context TEXT NOT NULL,
  subject TEXT NOT NULL,
  group_label TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY(pool_id, deployment_id, course_context, subject)
);
CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  course_context TEXT NOT NULL,
  subject TEXT NOT NULL,
  link_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  forwarded_json TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  redirect_issued INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_launch_course_time ON launches(deployment_id,course_context,occurred_at);
CREATE INDEX IF NOT EXISTS idx_launch_link_time ON launches(link_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_launch_subject_time ON launches(deployment_id,course_context,subject,occurred_at);
