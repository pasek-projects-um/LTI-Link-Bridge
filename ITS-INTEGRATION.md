# ITS integration and security review (DRAFT — NOT READY FOR APPROVAL)

## Purpose
LTI Link Bridge brokers Canvas-authenticated launches of instructor-configured allowlisted external activities, provides stable HMAC-keyed pseudonyms, and maintains per-launch audit history and course-limited mapping exports.

## Data collected and stored
- Verified LTI issuer/client/deployment, course context, user subject, optional Canvas name/email, roles (in transient processing), resource-link ID, timestamp, link target origin, pseudonymized codes, export audit metadata.
- Sensitive `identities`/`identity_codes` are separated from general `launches` in SQL tables, but **not** in separate encryption domains or databases yet.
- Section membership may now be instructor-managed through an authenticated, course-scoped dashboard, only for subjects established by verified LTI launches. Multiple memberships are stored and manual edits audited. Current Canvas API section lookup is not implemented.

## Data transmitted to destinations
Only selected HMAC pseudonyms for user/course/section plus link ID and per-launch UUID query parameters. No raw Canvas subject, SIS ID, name, or email. An optional destination-side JavaScript helper can send activity events to an endpoint operated by the destination itself; no direct browser event-ingestion API is currently enabled on the Bridge. URL query parameters can appear in recipient logs and history and therefore must not be treated as confidential authentication credentials.

## LTI and Canvas permissions
LTI 1.3 OIDC login, resource launch, and Deep Linking. No Canvas API permissions used in this milestone; future section membership lookup will require separately scoped API authorization and institutional consent.

## Authentication
Platform RS256 ID token verified against platform JWKS using `jose`; checks issuer/audience/deployment/state/nonce/claims. States stored in Cloudflare D1. Instructor access is course-scoped to verified LTI roles and sessions. A one-use D1 continuation ticket opens the instructor dashboard or Deep Linking builder in a top-level tab to mitigate blocked iframe cookies. Browser compatibility, return URL restrictions and CSRF controls still require institutional review.

## Storage, retention, deletion
Cloudflare Workers + D1, region/account-dependent location. No automated retention, legal hold, purge, or subject access procedure yet. Institution must define retention periods and Cloudflare vendor requirements before approval.

## Required registration URLs
- OIDC login initiation: `https://<approved-host>/lti/login`
- Redirect / launch: `https://<approved-host>/lti/launch`
- Public tool JWKS: `https://<approved-host>/lti/jwks`
- Expected LTI 1.3 issuer, client ID, deployment ID, Canvas authorization URL, Canvas JWKS URL and environment (production/test/beta).

## Keys and configuration
- `HMAC_KEY_V1`, `SESSION_SECRET`: independent, strong random secrets in Workers Secrets.
- `TOOL_PRIVATE_JWK`: optional RSA private JWK for Deep Linking; securely stored in Workers Secrets.
- Approved outbound domain allowlist; public base URL; Canvas platform registrations stored in D1.
- Data retention schedule and staff authorization policy are TBD.

## Testing and approval checklist
- [x] Implement local test-key Canvas simulator and automated OIDC, replay, launch, Deep Linking and authorization tests (Cloudflare CI).
- [ ] Extend test suite and perform Canvas browser validation with university test environment.
- [ ] Resolve third-party cookie behavior under Canvas iframe restrictions.
- [ ] Validate Canvas placement and protected deep link return destination.
- [ ] Verify course and instructor access isolation under adversarial scenarios.
- [x] Implement cursor-streamed complete CSV exports, CSV formula neutralization and identity-export audits.
- [ ] Load-test institutional-scale exports and confirm institution-approved audit retention.
- [ ] Review FERPA classification, institutional vendor agreement, data residency, retention, breach reporting and incident response.
- [ ] Conduct dependency/security assessment and network testing.
- [ ] Register in institutional test Canvas and validate without production student data.
- [ ] Review final deployment and ITS approval.
