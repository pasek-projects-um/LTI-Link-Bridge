CREATE TABLE IF NOT EXISTS deep_link_contexts (
  challenge TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  return_url TEXT NOT NULL,
  return_data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deep_context_expiry ON deep_link_contexts(expires_at);
