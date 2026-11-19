-- Every student has their own reuse policy for each activity.
-- A generation is an individual activity attempt. Reopening the same generation
-- creates another launch event, not another generation.
ALTER TABLE links ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'new_each_time'
  CHECK(generation_mode IN ('once_per_student','reuse_generation','new_each_time'));

ALTER TABLE launches ADD COLUMN generation_id TEXT;

CREATE TABLE IF NOT EXISTS link_generations (
  generation_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_launch_id TEXT,
  FOREIGN KEY(link_id) REFERENCES links(id)
);

CREATE INDEX IF NOT EXISTS idx_link_generations_student
  ON link_generations(deployment_id,course_id,link_id,user_id,created_at);

-- Only once-per-student and reuse-generation modes use this row as a lock.
-- New-each-time creates a distinct generation row for each launch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_generations_reusable
  ON link_generations(deployment_id,course_id,link_id,user_id)
  WHERE generation_id LIKE 'stable-%';
