# ITS integration and security review (DRAFT — NOT READY FOR APPROVAL)

## Purpose
LTI Link Bridge brokers Canvas-authenticated launches of instructor-configured allowlisted external activities, provides stable HMAC-keyed pseudonyms, and maintains per-launch audit history and course-limited mapping exports.

## Data collected and stored
- Verified LTI issuer/client/deployment, course context, user subject, optional Canvas name/email, roles (in transient processing), resource-link ID, timestamp, link target origin, pseudonymized codes, export audit metadata.
- Sensitive `identities`/`identity_codes` are separated from general `launches` in SQL tables, but **not** in separate encryption domains or databases yet.
- Section membership may now be instructor-managed through an authenticated, course-scoped dashboard, only for subjects established by verified LTI launches. Multiple memberships are stored and manual edits audited. Optional Canvas API section lookup is implemented and simulator-tested; production Canvas permissions remain unverified.

## Data transmitted to destinations
Only selected HMAC pseudonyms for user/course/section plus link ID and per-launch UUID query parameters. No raw Canvas subject, SIS ID, name, or email. An optional destination-side JavaScript helper can send activity events to an endpoint operated by the destination itself. The Bridge separately supports an authenticated server-to-server arrival API: destination servers report `opened`, `started`, `submitted`, or `finished` events using per-link 256-bit bearer secrets (stored hashed in D1) that are never forwarded in URLs or browser JavaScript. These callbacks are destination assertions, not independent proof of student completion. URL query parameters can appear in recipient logs and history and therefore must not be treated as confidential authentication credentials.

## LTI and Canvas permissions
LTI 1.3 OIDC login, resource launch, and Deep Linking. Optional Canvas enrollment API lookup is supported, but disabled until an institution configures its approved origin and separate bearer credential.

## Authentication
Platform RS256 ID token verified against platform JWKS using `jose`; checks issuer/audience/deployment/state/nonce/claims. States stored in Cloudflare D1. Instructor access is course-scoped to verified LTI roles and sessions. A one-use D1 continuation ticket opens the instructor dashboard or Deep Linking builder in a top-level tab to mitigate blocked iframe cookies. Browser compatibility, return URL restrictions and CSRF controls still require institutional review.

## Storage, retention, deletion
Cloudflare Workers + D1, region/account-dependent location. The instructor dashboard formats timestamps in the instructor browser's local time zone without altering UTC export records. A daily scheduled cleanup now deletes expired ephemeral authentication state. Educational-record deletion is **disabled by default** pending approval. Once `RETENTION_ENABLED=1` and explicit launch/identity/audit retention durations are configured, the Worker deletes aged launches, arrival reports, orphaned protected identity mappings/section assignments, and aged audit entries in bounded batches. Legal hold, exemptions, access requests, backup-restoration treatment, and institution-specific periods still require an approved operating procedure before this can be enabled.

## Required registration URLs
- OIDC login initiation: `https://<approved-host>/lti/login`
- Redirect / launch: `https://<approved-host>/lti/launch`
- Public tool JWKS: `https://<approved-host>/lti/jwks`
- Expected LTI 1.3 issuer, client ID, deployment ID, Canvas authorization URL, Canvas JWKS URL and environment (production/test/beta).

## Deep Linking return URL controls

The registration's exact OIDC authentication origin is permitted by default; if the authorized Canvas Deep Linking callback uses a different origin, configure the exact additional origin in `deployments.deep_link_return_origins` before testing. Wildcard return hosts and arbitrary instructor-provided callback origins are rejected. Loopback HTTP is permitted only in explicitly configured local simulation.

## Canvas enrollment API integration

Optional per-deployment Canvas section lookup is implemented but not yet validated against a real Canvas instance. ITS should set `deployments.canvas_api_origin` to the exact trusted Canvas origin and provision `CANVAS_API_TOKENS` as a Worker Secret containing a JSON object mapping internal deployment IDs to separate Canvas bearer credentials. No token is sent to students or destination websites. Confirm that `GET /api/v1/courses/{course_id}/enrollments?user_id={user_id}&type[]=StudentEnrollment` is available with the approved account permissions and that LTI context/user IDs correspond to Canvas REST IDs. No wildcard API hosts, redirects, or arbitrary API origins are permitted.

API results are filtered to the exact user/course, active/invited enrollments and valid section IDs. All memberships are stored; instructor overrides take precedence. A failed lookup retains existing mappings, while section-required links fail if no verified or manual mapping is known. Use a least-privilege account/token, credential rotation, and institutional access review.

## Keys and configuration
- `HMAC_KEY_V1`, `SESSION_SECRET`: independent, strong random secrets in Workers Secrets.
- Optional `HMAC_KEY_V2` and `HMAC_ACTIVE_VERSION=v2` for an explicit versioned key transition. Existing courses keep their previous link key versions; preserve old secrets while those links remain active and coordinate any global identifier discontinuity with institutional policy.
- `TOOL_PRIVATE_JWK`: optional RSA private JWK for Deep Linking; securely stored in Workers Secrets.
- Approved outbound domain allowlist; public base URL; Canvas platform registrations stored in D1.
- Data retention schedule and staff authorization policy are TBD.

## Optional instructor live session codes

The bridge now supports code-gated cohorts on individual activities. Instructors explicitly enable the feature at link creation and start/close sessions from the protected instructor dashboard; the code is shown only upon creation and stored as an HMAC-protected hash. Students must still authenticate through Canvas and enter the class code before being admitted; a later Canvas launch passes the pseudonymous `live_session` cohort ID to the destination. Each verified Canvas click remains separately logged. Up to five incorrect attempts within fifteen minutes are allowed for an individual student/session.

This is **not physical attendance attestation**: a code can be shared outside the room. Nor does the bridge itself protect destination endpoints from direct requests; destination services must isolate shared environments and independently validate access where necessary. Closing a live session stops new admissions and may optionally allow admitted users to resume. Migration `0012_live_sessions.sql` is required; review classroom code sharing and retention of `live_admissions` / `live_code_attempts` during the institutional privacy review.

## Canvas scheduling and complete verified click history

Canvas remains responsible for assignment due dates, available-from/until dates, differentiated recipients, publication and module restrictions. The bridge does not replicate or independently enforce those rules, and does not currently implement Assignment and Grade Services. Real Canvas assignment placement and Deep Linking compatibility remain pilot validation tasks.

Each authenticated student resource-launch attempt that reaches the generation-policy check is recorded in `launch_attempts`, including repeat visits refused under once-per-student mode. The dashboard and instructor CSV distinguish attempted clicks, accepted launches and generations. Canvas-rejected access and direct external website visits are **not observable** by the bridge. New generation scoping uses the signed Canvas resource-link placement, so separate assignments can use the same activity without sharing student single-use quotas.

Required migrations: `0010_launch_attempts.sql` and `0011_placement_scoped_generations.sql`. Attempt records use the same institution-approved retention period as launch history.

## Student activity reuse and generation semantics

The instructor chooses a per-student reuse policy for each new activity: once per student, reopen the same generation, or create a new generation on every visit. Each successful Canvas visit receives a unique launch ID; a generation ID identifies the activity attempt and can be reused across launches. The bridge forwards `generation` as a query parameter, but the destination must implement persistence/resumption using that identifier if reopening is desired.

The policy is enforced using the **verified Canvas user ID** scoped to deployment, course and activity, not a browser-supplied student code. The database stores generation history in `link_generations` and attaches `generation_id` to launch records. Migration `0009_link_generations.sql` is required. Existing activity links default to their prior behavior (new generation on every visit). Real Canvas testing is still required before classroom deployment.

## Additional hardening completed in the development simulator

- OIDC login accepts only the canonical tool launch URL, without query parameters or fragments; tokens must also satisfy issuer, audience, nonce, deployment, expiry and exact LTI role claim validation.
- Resource-link bindings are enforced for existing placements and checked after concurrent initial binding attempts. Copying or restoring course links still needs validation in real Canvas.
- Destination URL construction strips preexisting bridge-managed query names (even when forwarding is disabled) so an instructor-configured URL cannot accidentally supply misleading student, course or section codes.
- Instructor forms enforce identifier and title constraints; a section-required activity must enable section forwarding.
- A successful launch is recorded before redirect, with duplicate token rejection; identity metadata is written in the same transactional D1 batch.
- Signed Deep Linking launches create an expiring, single-use D1 context. The context and new link are committed atomically; retries after the first save are rejected. The new context table is created in migration `0008_deep_link_contexts.sql` and scheduled cleanup removes expired requests.
- These checks are validated against the local signed simulator, **not** a U-M Canvas integration. Do not claim an institutional penetration test, privacy approval or production readiness.

## Testing and approval checklist
- [x] Implement local test-key Canvas simulator and automated OIDC, replay, launch, Deep Linking and authorization tests (Cloudflare CI).
- [ ] Extend test suite and perform Canvas browser validation with university test environment.
- [ ] Resolve third-party cookie behavior under Canvas iframe restrictions.
- [x] Add explicit registered-origin validation for Deep Linking callbacks.
- [ ] Validate Canvas placement and actual institutional return URL with ITS.
- [ ] Obtain ITS-approved, least-privilege Canvas API credential and validate section enrollment query, pagination, API IDs and revocation.
- [ ] Verify course and instructor access isolation under adversarial scenarios.
- [x] Implement cursor-streamed complete CSV exports, CSV formula neutralization and identity-export audits.
- [ ] Load-test institutional-scale exports and confirm institution-approved audit retention.
- [ ] Approve explicit `RETENTION_ENABLED`, launch/identity/audit retention intervals, legal holds and handling of backups prior to any real deletion.
- [ ] Review who can generate and hold per-link destination callback credentials, server-to-server arrival event reliability, retention and incident response.
- [ ] Review FERPA classification, institutional vendor agreement, data residency, retention, breach reporting and incident response.
- [ ] Conduct dependency/security assessment and network testing.
- [ ] Register in institutional test Canvas and validate without production student data.
- [ ] Review final deployment and ITS approval.

## Controlled Canvas test registration — handoff procedure

**Status: pending institutional access and approval.** Do not register this tool in production Canvas, insert real student data, or deploy to an institutional account without authorization.

1. ITS identifies a Canvas **test or beta environment**, its exact LTI issuer, OIDC authorization URL, JWKS URL, a test course, and two or more synthetic test users (instructor and students in different sections). Confirm test Canvas data policy before using any accounts.
2. ITS approves an isolated Cloudflare test Worker and D1 database, a public HTTPS hostname, data location, retention plan, and who may administer credentials. Create independent random secrets for `HMAC_KEY_V1`, `SESSION_SECRET`, and `TOOL_PRIVATE_JWK` (RSA private JWK). Store as Worker secrets; never send them through email, issues, PRs or this handoff file.
3. Copy `config/test-wrangler.example.json` outside the repository, replace placeholders, and run `npm run preflight -- --config <path>`. **Do not deploy using the repository's local simulator `wrangler.jsonc`.** The preflight rejects localhost, the placeholder D1 UUID, plaintext secrets in vars, and development-only HTTP.
4. Obtain a Canvas developer-key registration for LTI 1.3 with tool login `https://<test-host>/lti/login`, launch `https://<test-host>/lti/launch`, tool JWKS `https://<test-host>/lti/jwks`, Deep Linking enabled, and an instructor placement. Complete `config/canvas-test-registration.example.json` with **non-secret identifiers only**; run `npm run preflight -- --config <path> --registration <path>`.
5. Deploy the Worker only after institutional approval. Apply all D1 migrations to the **test database**, provision the approved deployment registration in D1, and confirm the JWKS endpoint serves the public key matching the private signing secret. The test Canvas developer key and tool deployment must match the issuer/client/deployment tuple exactly.
6. If ITS approves section resolution, provision `CANVAS_API_TOKENS` as a secret keyed by internal deployment ID, set the deployment's `canvas_api_origin`, and confirm `/api/v1/courses/{course_id}/enrollments` is accessible using a least-privilege credential. Section mapping remains optional.
7. Test the following **in Canvas UI**: instructor launches dashboard; Deep Linking adds an approved HTTPS activity; two synthetic students launch; repeat launches yield separate UUIDs but stable course-scoped pseudonyms; students cannot access instructor dashboard/identity CSV; instructor can see individual launches and export; automatic and manual sections behave correctly; destination callback reports an arrival distinctly from a redirect; an invalid link and replay fail safely.
8. Record observed results and browser/version, iframe vs top-level behavior, Canvas environment, permissions, and a security review sign-off. Disable/revoke test credentials after testing if no further work is authorized.

### Acceptance criteria and stop conditions

**Pass** only if signed LTI launches work from Canvas, Deep Linking is accepted, course isolation holds, no raw identifiers reach the destination, all launches appear in the instructor history, sections match Canvas enrollment, and staff can reproduce the workflow without CLI access. **Stop** if test users can access another course, a secret appears in a URL, a redirect occurs without durable logging, Canvas iframe cookies prevent access without the top-level continuation, or the test environment contains unauthorized student data.

### Items ITS must provide before a real test

- Approved Canvas test/beta environment, LTI developer-key and deployment IDs, and permission to configure a test course.
- Approved Cloudflare test account, D1 location, HTTPS hostname and responsible administrator.
- Test-only instructor/student accounts, section assignments and a test destination URL.
- Optional Canvas enrollment API credential and approved permissions.
- FERPA/privacy, retention and security contacts for test approval.

**Never paste Canvas API tokens, Worker signing keys or actual student records into GitHub issues or documentation.**
