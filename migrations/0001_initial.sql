PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY, institution TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL, auth_url TEXT NOT NULL, jwks_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(issuer,client_id,deployment_id)
);
CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, deployment_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY(deployment_id) REFERENCES deployments(id)
);
CREATE INDEX IF NOT EXISTS idx_states_expiry ON oidc_states(expires_at);
CREATE TABLE IF NOT EXISTS identities (
  deployment_id TEXT NOT NULL, course_id TEXT NOT NULL, user_id TEXT NOT NULL,
  full_name TEXT, email TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY(deployment_id,course_id,user_id),
  FOREIGN KEY(deployment_id) REFERENCES deployments(id)
);
CREATE TABLE IF NOT EXISTS instructors (
  deployment_id TEXT NOT NULL, course_id TEXT NOT NULL, user_id TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  PRIMARY KEY(deployment_id,course_id,user_id)
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, course_id TEXT NOT NULL,
  title TEXT NOT NULL, destination TEXT NOT NULL, user_scope TEXT NOT NULL DEFAULT 'course'
    CHECK(user_scope IN ('global','course','activity')),
  forward_user INTEGER NOT NULL DEFAULT 1, forward_course INTEGER NOT NULL DEFAULT 1,
  forward_section INTEGER NOT NULL DEFAULT 0, forward_link INTEGER NOT NULL DEFAULT 1,
  forward_launch INTEGER NOT NULL DEFAULT 1,
  section_required INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(deployment_id) REFERENCES deployments(id)
);
CREATE INDEX IF NOT EXISTS idx_links_course ON links(deployment_id,course_id);
CREATE TABLE IF NOT EXISTS link_resources (
  deployment_id TEXT NOT NULL, course_id TEXT NOT NULL, resource_link_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  PRIMARY KEY(deployment_id,course_id,resource_link_id),
  FOREIGN KEY(link_id) REFERENCES links(id)
);
CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY, token_fingerprint TEXT NOT NULL UNIQUE, event_time TEXT NOT NULL,
  deployment_id TEXT NOT NULL, institution TEXT NOT NULL, course_id TEXT NOT NULL,
  course_code TEXT NOT NULL, user_code TEXT NOT NULL, section_code TEXT,
  link_id TEXT NOT NULL, destination_origin TEXT NOT NULL,
  resource_link_id TEXT NOT NULL, status TEXT NOT NULL,
  redirect_status TEXT NOT NULL, error_code TEXT,
  key_version TEXT NOT NULL DEFAULT 'v1',
  FOREIGN KEY(link_id) REFERENCES links(id)
);
CREATE INDEX IF NOT EXISTS idx_launch_course_time ON launches(deployment_id,course_id,event_time DESC);
CREATE INDEX IF NOT EXISTS idx_launch_link_time ON launches(link_id,event_time DESC);
CREATE INDEX IF NOT EXISTS idx_launch_user_time ON launches(deployment_id,course_id,user_code,event_time DESC);
CREATE TABLE IF NOT EXISTS identity_codes (
  deployment_id TEXT NOT NULL, course_id TEXT NOT NULL, user_id TEXT NOT NULL,
  user_code TEXT NOT NULL, scope TEXT NOT NULL, link_id TEXT NOT NULL DEFAULT '',
  key_version TEXT NOT NULL,
  PRIMARY KEY(deployment_id,course_id,user_id,user_code),
  FOREIGN KEY(deployment_id,course_id,user_id) REFERENCES identities(deployment_id,course_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_codes_code ON identity_codes(user_code);
CREATE TABLE IF NOT EXISTS section_memberships (
  deployment_id TEXT NOT NULL, course_id TEXT NOT NULL, user_id TEXT NOT NULL,
  section_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'instructor',
  PRIMARY KEY(deployment_id,course_id,user_id,section_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, time TEXT NOT NULL, deployment_id TEXT NOT NULL,
  course_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_course ON audit_events(deployment_id,course_id,time DESC);
