-- Optional instructor-controlled live cohorts. Codes are never stored in plaintext.
-- The scope is the course and bridge activity; Canvas still owns assignment scheduling.
ALTER TABLE links ADD COLUMN live_code_required INTEGER NOT NULL DEFAULT 0
  CHECK(live_code_required IN (0,1));

CREATE TABLE live_sessions (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  label TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  allow_admitted_resume INTEGER NOT NULL DEFAULT 1 CHECK(allow_admitted_resume IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY(link_id) REFERENCES links(id)
);
-- At most one live class session accepts new admissions for an activity.
CREATE UNIQUE INDEX idx_one_open_live_session
  ON live_sessions(deployment_id,course_id,link_id) WHERE state='open';
CREATE INDEX idx_live_sessions_course
  ON live_sessions(deployment_id,course_id,link_id,created_at DESC);

CREATE TABLE live_admissions (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  PRIMARY KEY(session_id,user_id),
  FOREIGN KEY(session_id) REFERENCES live_sessions(id)
);
CREATE TABLE live_code_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_code TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('accepted','incorrect','rate_limited')),
  FOREIGN KEY(session_id) REFERENCES live_sessions(id)
);
CREATE INDEX idx_live_code_attempts_session
  ON live_code_attempts(session_id,attempted_at DESC);
CREATE INDEX idx_live_code_attempts_rate
  ON live_code_attempts(session_id,user_code,attempted_at DESC);

ALTER TABLE launches ADD COLUMN live_session_id TEXT;
ALTER TABLE launch_attempts ADD COLUMN live_session_id TEXT;
