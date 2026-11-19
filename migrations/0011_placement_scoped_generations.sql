-- Canvas placement (resource_link_id) is part of a student's generation
-- identity. Two assignments pointing to the same bridge activity must not
-- share a single-use quota or a reusable generation.
ALTER TABLE link_generations ADD COLUMN resource_link_id TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_link_generations_reusable;
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_generations_reusable
  ON link_generations(deployment_id,course_id,link_id,resource_link_id,user_id)
  WHERE generation_id LIKE 'stable-%';
CREATE INDEX IF NOT EXISTS idx_link_generations_placement
  ON link_generations(deployment_id,course_id,resource_link_id,user_id);
