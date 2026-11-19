-- A verified Canvas request is an attempt even when a single-use policy
-- prevents the student from opening the destination. Unlike launches, these
-- rows include rejected repeat attempts. They do not represent browser
-- clicks that never reach the bridge (for example, Canvas-blocked access).
CREATE TABLE IF NOT EXISTS launch_attempts (
  attempt_id TEXT PRIMARY KEY,
  attempted_at TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  resource_link_id TEXT NOT NULL,
  user_code TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('launched','blocked_single_use','duplicate_token')),
  launch_id TEXT,
  generation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_course_time
  ON launch_attempts(deployment_id,course_id,attempted_at);
CREATE INDEX IF NOT EXISTS idx_attempts_student_activity
  ON launch_attempts(deployment_id,course_id,link_id,user_code,attempted_at);
