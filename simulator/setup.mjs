import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';

const root = join(process.cwd(), '.simulator');
mkdirSync(root, { recursive: true });
function rsaPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  publicJwk.kid = 'simulator-test-v1';
  privateJwk.kid = 'simulator-test-v1';
  return { publicJwk, privateJwk };
}
const platform = rsaPair();
const alternate = rsaPair();
const tool = rsaPair();
const keys = { platform, alternate, tool };
writeFileSync(join(root, 'keys.json'), JSON.stringify(keys), { mode: 0o600 });
const rand = () => randomBytes(32).toString('base64url');
const vars = [
  'HMAC_KEY_V1=' + rand(),
  'SESSION_SECRET=' + rand(),
  'TOOL_PRIVATE_JWK=' + JSON.stringify(tool.privateJwk),
  'ENABLE_LOCAL_HTTP=1',
  'DESTINATION_ALLOWLIST=localhost,127.0.0.1',
  ''
].join('\n');
if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', vars, { mode: 0o600 });
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const bootstrap = [
  "INSERT OR IGNORE INTO deployments(id,institution,issuer,client_id,deployment_id,auth_url,jwks_url) VALUES('sim-1','sim-university','http://localhost:8788','bridge-simulator','sim-deployment','http://localhost:8788/authorize','http://localhost:8788/jwks');",
  "INSERT OR IGNORE INTO deployments(id,institution,issuer,client_id,deployment_id,auth_url,jwks_url) VALUES('sim-2','sim-university','http://localhost:8788','bridge-simulator','second-deployment','http://localhost:8788/authorize','http://localhost:8788/jwks');",
  "INSERT OR IGNORE INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES('sim-activity-a','sim-1','course-a','Simulation Activity A','http://localhost:8788/activity?keep=yes#test','course',1,1,1,1,1,0,'teacher-1','" + now + "');",
  "INSERT OR IGNORE INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES('sim-activity-b','sim-1','course-a','Simulation Activity B','http://localhost:8788/activity','activity',1,1,0,1,1,0,'teacher-1','" + now + "');",
  "INSERT OR IGNORE INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES('sim-activity-c','sim-1','course-b','Course B Activity','http://localhost:8788/activity','course',1,1,0,1,1,0,'teacher-2','" + now + "');",
  "INSERT OR IGNORE INTO section_memberships(deployment_id,course_id,user_id,section_id,source) VALUES('sim-1','course-a','student-1','section-1','simulator');",
  "INSERT OR IGNORE INTO section_memberships(deployment_id,course_id,user_id,section_id,source) VALUES('sim-1','course-a','student-1','section-2','simulator');",
  ''
].join('\n');
writeFileSync(join(root, 'bootstrap.sql'), bootstrap);
console.log('Test-only Canvas simulator keys and D1 seed data generated.');
console.log('Next: npm run db:local && npx wrangler d1 execute DB --local --file=.simulator/bootstrap.sql');
