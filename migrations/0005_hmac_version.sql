ALTER TABLE links ADD COLUMN key_version TEXT NOT NULL DEFAULT 'v1' CHECK(key_version IN ('v1','v2'));
CREATE INDEX idx_links_key_version ON links(deployment_id,course_id,key_version);
