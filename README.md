# LTI Link Bridge

A **work-in-progress** institution-agnostic LTI 1.3 Canvas tool for linking to instructor-approved external activities with keyed pseudonyms and durable per-launch logs. Cloudflare Workers + D1 + TypeScript. Not yet suitable for storing real student records or for institutional registration.

## Current implementation (initial milestone)

- OIDC initiation, state and nonce storage, signature and claim verification using `jose`, issuer/audience/deployment validation.
- Stable versioned HMAC-SHA-256 pseudonyms for user (global/course/activity scopes), course, and instructor-managed sections.
- Verified resource launches, allowed HTTPS destinations, query preservation, D1 launch and protected identity writes before issuing a 303 redirect.
- Instructor-scoped dashboard, a link-creation screen, CSV export, and Deep Linking response signing (requires an RSA key).
- Preliminary local-independent identifier smoke tests.

## Important current limitations

This is **not a completed or security-reviewed LTI installation**. Local signed Canvas simulator and integration tests are now available. Canvas API section lookup, destination arrival confirmation, optional browser SDK, identity administration beyond manual section mappings, additional iframe compatibility testing, institutional provisioning, scheduled retention and production validation remain unfinished. The dashboard has basic UTC timestamps and 100-row paging; CSV exports stream with keyset pagination rather than truncating at 100,000 rows. In particular, the current link resource-association mechanism should be hardened against copy/forgery across placements before production. **Never put production credentials or student data into this initial implementation.**

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

Signed LTI claims are verified before processing. The service never forwards raw Canvas IDs or name/email to activities; it forwards only selected pseudonyms. Do not treat a pseudonym as a login credential or proof of identity. Instructors can access their course's identity exports, which are sensitive education records subject to institutional controls and FERPA. Do not retain records indefinitely by default; an approved institutional data-retention schedule and deletion mechanism are still required. Data remains in the configured Cloudflare D1 jurisdiction; institution must evaluate vendor/data-residency obligations.

Each accepted, authorized resource launch has its own UUID. Identical token retries are rejected, not logged a second time. A redirect means the Worker issued a Location header; it does **not** prove the browser opened the destination. `identity_codes` allows multiple codes and scopes per user. Multi-section instructor mappings are present in schema but currently only the lexicographically first section is used. ID versions currently use `v1`; key rotation requires an explicit migration and preserved old secrets.

## Repository

- `src/crypto.ts`: cryptography, JWT verification and signing.
- `src/index.ts`: Worker HTTP routes, verification, instructor tools, persistence.
- `src/links.ts`: destination validation and query construction.
- `migrations/`: D1 schema.
- `simulator/`: signed local Canvas simulator and test-key setup.
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

## Complete history exports

Course-scoped CSV exports now use 400-row keyset-paginated streams instead of the former 100,000-row limit. Exports preserve UTC timestamps. Identity exports record an audit event and neutralize spreadsheet-formula-like fields. Large-load validation and an institutional retention policy are still required.

## Remaining work before ITS review

Extend coverage of issuer/deployment edge cases, harden Deep Linking return URL registration, prohibit loopback URLs in production, add Canvas API section lookup, destination arrival callbacks, configurable user-identifier key rotation, retention/purge workflows, stronger audit controls, accessibility review and production deployment runbooks. Do not deploy or register against Michigan Canvas without explicit authorization.
