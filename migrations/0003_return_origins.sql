-- Only exact permitted platform origins may receive signed Deep Linking responses.
-- Defaults to the registered OIDC authentication origin.
ALTER TABLE deployments ADD COLUMN deep_link_return_origins TEXT;
