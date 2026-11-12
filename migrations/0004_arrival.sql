-- Each destination application receives a distinct random bearer credential.
-- Only a hash is stored; destination servers must preserve the cleartext key.
CREATE TABLE arrival_credentials (
  link_id TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  issued_by TEXT NOT NULL
);
CREATE TABLE arrival_events (
  id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL REFERENCES launches(id),
  link_id TEXT NOT NULL REFERENCES links(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('opened','started','submitted','finished')),
  observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
  nonce TEXT NOT NULL,
  UNIQUE(link_id,nonce)
);
CREATE INDEX idx_arrival_launch ON arrival_events(launch_id,event_type,observed_at);
CREATE INDEX idx_arrival_link ON arrival_events(link_id,received_at DESC);
