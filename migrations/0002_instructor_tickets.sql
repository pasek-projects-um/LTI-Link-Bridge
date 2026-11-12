CREATE TABLE IF NOT EXISTS instructor_tickets (
  ticket TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  next_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_instructor_tickets_expiry ON instructor_tickets(expires_at);
