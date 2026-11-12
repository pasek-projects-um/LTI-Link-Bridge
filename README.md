# LTI Link Bridge

A **work-in-progress** institution-agnostic LTI 1.3 Canvas tool for linking to instructor-approved external activities with keyed pseudonyms and durable per-launch logs. Cloudflare Workers + D1 + TypeScript. Not yet suitable for storing real student records or for institutional registration.

## Current implementation (initial milestone)

- OIDC initiation, state and nonce storage, signature and claim verification using `jose`, issuer/audience/deployment validation.
- Stable versioned HMAC-SHA-256 pseudonyms for user (global/course/activity scopes), course, and instructor-managed sections.
- Verified resource launches, allowed HTTPS destinations, query preservation, D1 launch and protected identity writes before issuing a 303 redirect.
- Instructor-scoped dashboard, a link-creation screen, CSV export, and Deep Linking response signing (requires an RSA key).
- Preliminary local-independent identifier smoke tests.

## Important current limitations

This is **not a completed or security-reviewed LTI installation**. Local signed Canvas simulator and integration tests are now available. Canvas API section lookup, institution-specific destination-server integration, identity administration beyond manual section mappings, additional iframe/browser compatibility testing, institutional provisioning, approved retention policy and production validation remain unfinished. The dashboard shows timestamps in the instructor browser's local time zone (with a UTC fallback) and uses 100-row paging; CSV exports retain UTC and stream with keyset pagination rather than truncating at 100,000 rows. In particular, the current link resource-association mechanism should be hardened against copy/forgery across placements before production. **Never put production credentials or student data into this initial implementation.**

## Install and local start

1. Install Node.js 20+; run `npm install`.
2. Create a D1 database: `npx wrangler d1 create lti-link-bridge`, then copy the returned database ID into `wrangler.jsonc`.
3. Copy `.dev.vars.example` to `.dev.vars`; generate two independent 32-byte cryptographically random base64url values for `HMAC_KEY_V1` and `SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
4. To permit a local destination over HTTP, set `ENABLE_LOCAL_HTTP=1` **for local testing only**. Set `DESTINATION_ALLOWLIST=example.edu,activities.example.org` for approved HTTPS sites.
5. `npm run db:local` and `npm run dev`.
6. Manually provision an LTI platform registration by inserting into D1: `INSERT INTO deployments(id,institution,issuer,client_id,deployment_id,auth_url,jwks_url) VALUES('dev-1','local','https://platform.example','client123','deployment123','https://platform.example/authorize','https://platform.example/jwks');`. These values are **examples** and will not authorize a real launch.
7. `npm test` runs offline pseudonym smoke tests. `npm run typecheck` requires installed dependencies.

To use Canvas, request an LTI 1.3 developer-key registration with login initiation `https://<worker>/lti/login`, target/redirect `https://<worker>/lti/launch`, and tool public keyset `https://<worker>/lti/jwks`. Deep Linking requires a private RSA JWK in `TOOL_PRIVATE_JWK` and suitable Canvas configuration. See [ITS-INTEGRATION.md](ITS-INTEGRATION.md).

## Data and trust

Signed LTI claims are verified before processing. The service never forwards raw Canvas IDs or name/email to activities; it forwards only selected pseudonyms. Do not treat a pseudonym as a login credential or proof of identity. Instructors can access their course's identity exports, which are sensitive education records subject to institutional controls and FERPA. Scheduled deletion of educational records is disabled until an institution explicitly approves and configures its policy; ephemeral auth tokens can be cleaned automatically. Data remains in the configured Cloudflare D1 jurisdiction; institution must evaluate vendor/data-residency obligations.

Each accepted, authorized resource launch has its own UUID. Identical token retries are rejected, not logged a second time. A redirect means the Worker issued a Location header; it does **not** prove the browser opened the destination. `identity_codes` allows multiple codes and scopes per user. Multi-section instructor mappings are present in schema but currently only the lexicographically first section is used. Identifier secret rotation supports explicit `v1` and `v2` keys. Existing links retain their pinned version; a newly created course uses `HMAC_ACTIVE_VERSION`. Old keys must be retained while old links are active, and switching versions changes codes across newly rotated scopes.

## Repository

- `src/crypto.ts`: cryptography, JWT verification and signing.
- `src/index.ts`: Worker HTTP routes, verification, instructor tools, persistence.
- `src/links.ts`: destination validation and query construction.
- `migrations/`: D1 schema.
- `simulator/`: signed local Canvas simulator and test-key setup.
- `browser/`: optional destination-side activity instrumentation helper.
- `tests/`: offline identifier tests and genuine OIDC / Deep Linking integration tests.
- `ITS-INTEGRATION.md`: institutional review worksheet.

## Local Canvas simulator (implemented)

The simulator uses test RSA signing keys and exercises the real OIDC and LTI verification routes, rather than bypassing authentication. It includes simulated instructors and students, multiple courses and sections, repeat launches, malformed signatures, incorrect issuer/audience/deployments, expired tokens and Deep Linking.

1. Install Node.js 22+ and run `npm install`.
2. Run `npm run simulator:setup` to generate gitignored `.simulator/keys.json`, `.simulator/bootstrap.sql`, and (if missing) `.dev.vars`. Never commit these test secrets.
3. Run `npm run db:local` and then `npx wrangler d1 execute DB --local --file=.simulator/bootstrap.sql`.
4. Start `npm run dev` and in another terminal start `node simulator/server.mjs`.
5. Open `http://localhost:8788` to launch a simulated instructor or student. A Deep Linking request opens the instructor link builder and can return a signed configured link to simulated Canvas.
6. With both servers running, `npm run test:integration` exercises authentication, replay rejection, logging, scopes, dashboard access, exports, Deep Linking and section administration. GitHub Actions runs the same integration suite automatically.

This is a *test platform*, not a Canvas UI clone. Never expose the simulator keys or enable `ENABLE_LOCAL_HTTP` for a real institutional installation.

## Browser session fallback

Canvas iframes may block cross-site cookies. After verified instructor authentication, a new-tab link uses a one-time D1 continuation ticket (five-minute expiry) to issue a top-level Secure, HttpOnly, SameSite=Lax cookie. Replay is rejected. This path has automated local coverage, but still needs testing across institutional browsers.

## Instructor-managed sections

Course dashboards link to **Manage sections**. An authorized instructor can map verified, previously observed Canvas user IDs to multiple section IDs, or remove instructor-created memberships. The record is explicitly marked as manually supplied; Canvas API section verification remains an integration task. The default forwarded section is the first section in lexicographic ID order. Unresolved sections are omitted unless the link requires them.

## Instructor-local times without altering UTC records

Chronological launch timestamps, first/last launches, and destination-reported opening times render as semantic `<time>` elements. A small same-origin JavaScript file formats them using the instructor browser's detected IANA time zone; JavaScript-disabled browsers fall back to explicit UTC strings. The daily aggregation still uses UTC calendar days and is labeled accordingly. All CSV exports retain ISO-8601 UTC timestamps, independently of browser display.

## Complete history exports

Course-scoped CSV exports now use 400-row keyset-paginated streams instead of the former 100,000-row limit. Exports preserve UTC timestamps. Identity exports record an audit event and neutralize spreadsheet-formula-like fields. Large-load validation and institutional retention-policy approval are still required.

## Optional destination-side JavaScript helper

See `browser/bridge-client.mjs`. Destination websites can copy or bundle this small ES module; it is not tied to CourseApps or to a particular learning platform. It parses only validated pseudonymous URL parameters and can emit `page_opened`, `activity_started`, `submission_completed`, and `activity_finished` messages to a **same-origin receiver implemented by the destination**.

Example:

~~~javascript
import { createBridgeTracker } from './bridge-client.mjs';
const tracker = createBridgeTracker({ endpoint: '/api/activity-events' });
await tracker.pageOpened();
await tracker.activityStarted();
await tracker.submissionCompleted({ result: 'saved' });
await tracker.activityFinished();
~~~

The destination's endpoint must implement its own authorization, retention and analytics. The helper **does not report events to the Bridge** or confirm arrival unless a trusted server-side integration is added. Pseudonyms and launch UUIDs are correlation values, never authentication credentials. Do not include personal data in arbitrary event metadata.

## Destination-side arrival confirmation (optional)

By default the bridge records only that the redirect was **issued**, not that a browser actually loaded the external website. For cooperative destinations, a verified course instructor can open **Arrival callbacks** in the dashboard and generate a 256-bit, per-link bearer credential. Its SHA-256 hash is stored in D1; the raw credential is shown once and must live exclusively in the destination server's secret store.

After receiving a student page request, the destination **server** (never browser JavaScript) may POST JSON to `https://<bridge-host>/api/arrival` with the header `Authorization: Bearer <per-link-secret>` and `Content-Type: application/json`:

~~~json
{"link":"<configured-link-id>","launch":"<launch-uuid>","event":"opened","nonce":"<fresh-at-least-128-bit-random-URL-safe-value>","observed_at":"2026-11-12T21:00:00.000Z"}
~~~

Events may be `opened`, `started`, `submitted`, or `finished`. The server checks the credential against that link, requires an existing launch, accepts timestamps within five minutes of server receipt and at most 48 hours after the original launch, and rejects reused nonces (HTTP 409). It records distinct immutable arrival events without converting `redirect_status=issued` into an unsupported claim about browser success. The instructor dashboard and launch CSV distinguish confirmed destination reports from unconfirmed redirects. `observed_at` is the destination's statement; it is not cryptographically attested independent evidence of browser activity. Rotate the credential if compromised; previous tokens stop working.

**Security:** launch UUIDs and pseudonymous URL codes are not credentials. Never put the bearer token in the student's query string, frontend JavaScript, HTML, or repository. Only the external destination's trusted server should make arrival API calls. The Bridge intentionally does not allow cross-origin browser calls.

## Platform-approved Deep Linking return URLs

A signed LTI Deep Linking request is additionally restricted to return to the registered platform authentication origin or an exact explicitly configured origin in the deployment's `deep_link_return_origins` field (comma-separated, origin-only). Unrelated HTTPS sites and callback URLs containing credentials/fragments are rejected before creating an instructor session. This protects against forwarding a signed Deep Linking response to an arbitrary external site. The local Canvas simulator uses the loopback platform origin. Configure authorized non-authentication Canvas return origins explicitly with ITS rather than permitting wildcard domains.

## Explicit HMAC key rotation

Each configured link has a `key_version` (`v1` by default in migrations). In the deployment's secret store, set `HMAC_KEY_V1` to the original, stable 32-byte base64url secret. To roll out a new key, add `HMAC_KEY_V2` (a separately generated 32-byte base64url secret) and set `HMAC_ACTIVE_VERSION=v2`. **Existing courses remain pinned to their original key version when new links are added; new courses use the active version.** Never overwrite or remove the v1 key while historical v1 links are in use. The active version defaults to v1 when unspecified.

Old launches preserve their recorded pseudonyms and `key_version`; protected identity mappings allow instructors to reconcile rotations. Codes issued under a different key version are *intentionally different* and global codes across an old/new version boundary are not longitudinally stable. Coordinate any global tracking transition explicitly with institutional data governance. Rotation is not a transparent way to change the cryptographic key while keeping identical pseudonyms.

The local Canvas simulator intentionally sets both secrets and activates v2, so integration tests can verify that its preloaded course links remain v1 and a newly created course uses v2. Production environments should not copy simulator values.

## Retention and automatic deletion (disabled until authorized)

The Worker supports a daily UTC Cron Trigger (`05:00 UTC`) for technical-state cleanup. Expired OIDC states and instructor continuation tickets are deleted in bounded batches independent of educational-record retention, preventing indefinite accumulation of login-state tokens.

**Education-record deletion is disabled by default.** It requires `RETENTION_ENABLED=1` **and all three explicit settings**: `RETENTION_LAUNCH_DAYS`, `RETENTION_IDENTITY_DAYS`, and `RETENTION_AUDIT_DAYS`. The minimum launch retention is 30 days, identity retention cannot be shorter than launch retention, and audit retention cannot be shorter than identity retention. Values above 3,650 days are rejected. Example policy for **simulator only**: `90`, `180`, and `365` days.

Deletion runs in bounded chunks (300 old launch events and 300 old identities per run) and cascades manually through arrival events, identity-code mappings and instructor-managed sections; records with remaining attributable launches are preserved. Large historical backlogs may take multiple daily runs to clear. Periodic jobs do not delete configured links, active destination credentials, or verified instructor records. Real deployment must have ITS-approved retention, legal-hold, records-management, backup, appeal and disclosure procedures before enabling this setting.

During local development, run `npx wrangler dev --local --test-scheduled` and invoke `http://localhost:8787/cdn-cgi/local/scheduled?cron=0+5+*+*+*` to test the scheduled handler. The simulator seeds deliberately aged synthetic records and the integration suite confirms that those records are removed without affecting current launches or mapping entries. Do not enable scheduled-test endpoints for production traffic.

## Remaining work before ITS review

Complete Canvas API section lookup, verify institution-specific Deep Linking return origins, integrate authenticated destination-side arrival reporting, develop institutional key-rotation and retention operations, add stricter export/audit controls, load testing, accessibility review and a vetted production deployment runbook. Do not deploy or register against Michigan Canvas without explicit authorization.
