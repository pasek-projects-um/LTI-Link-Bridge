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
  'HMAC_KEY_V2=' + rand(),
  'HMAC_ACTIVE_VERSION=v2',
  'SESSION_SECRET=' + rand(),
  'TOOL_PRIVATE_JWK=' + JSON.stringify(tool.privateJwk),
  'ENABLE_LOCAL_HTTP=1',
  'DESTINATION_ALLOWLIST=localhost,127.0.0.1',
  'CANVAS_API_TOKENS='+JSON.stringify({'sim-1':'simulator-canvas-api-token'}),
  'RETENTION_ENABLED=1',
  'RETENTION_LAUNCH_DAYS=90',
  'RETENTION_IDENTITY_DAYS=180',
  'RETENTION_AUDIT_DAYS=365',
  ''
].join('\n');
if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', vars, { mode: 0o600 });
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const recent = new Date().toISOString();
const bootstrap = [
  "INSERT OR IGNORE INTO deployments(id,institution,issuer,client_id,deployment_id,auth_url,jwks_url) VALUES('sim-1','sim-university','http://localhost:8788','bridge-simulator','sim-deployment','http://localhost:8788/authorize','http://localhost:8788/jwks');",
  "INSERT OR IGNORE INTO deployments(id,institution,issuer,client_id,deployment_id,auth_url,jwks_url) VALUES('sim-2','sim-university','http://localhost:8788','bridge-simulator','second-deployment','http://localhost:8788/authorize','http://localhost:8788/jwks');",
  "UPDATE deployments SET canvas_api_origin='http://localhost:8788' WHERE id='sim-1';",
  "INSERT OR IGNORE INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES('sim-activity-a','sim-1','course-a','Simulation Activity A','http://localhost:8788/activity?keep=yes#test','course',1,1,1,1,1,0,'teacher-1','" + now + "');",
  "INSERT OR IGNORE INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES('sim-activity-b','sim-1','course-a','Simulation Activity B','http://localhost:8788/activity','activity',1,1,0,1,1,0,'teacher-1','" + now + "');",
  "INSERT OR IGNORE INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES('sim-activity-c','sim-1','course-b','Course B Activity','http://localhost:8788/activity','course',1,1,0,1,1,0,'teacher-2','" + now + "');",
  "INSERT OR IGNORE INTO section_memberships(deployment_id,course_id,user_id,section_id,source) VALUES('sim-1','course-a','student-1','section-1','simulator');",
  "INSERT OR IGNORE INTO section_memberships(deployment_id,course_id,user_id,section_id,source) VALUES('sim-1','course-a','student-1','section-2','simulator');",
  ...Array.from({length:450},(_,i)=>{const user='cursor-student-'+String(i).padStart(3,'0');return [
    "INSERT OR IGNORE INTO identities(deployment_id,course_id,user_id,full_name,email,first_seen,last_seen) VALUES('sim-1','course-a','"+user+"','Cursor Test',NULL,'"+recent+"','"+recent+"');",
    "INSERT OR IGNORE INTO identity_codes(deployment_id,course_id,user_id,user_code,scope,link_id,key_version) VALUES('sim-1','course-a','"+user+"','U_cursor_"+String(i).padStart(3,'0')+"','course','','v1');"
  ]}).flat(),
  // One individual has hundreds of additional, distinct activity-scoped codes.
  // The export must advance within the same user rather than skipping on page 2.
  ...Array.from({length:450},(_,i)=>
    "INSERT OR IGNORE INTO identity_codes(deployment_id,course_id,user_id,user_code,scope,link_id,key_version) VALUES('sim-1','course-a','cursor-student-000','U_shared_"+String(i).padStart(3,'0')+"','activity','sim-activity-a','v1');"
  ),
  "INSERT OR IGNORE INTO identities(deployment_id,course_id,user_id,full_name,email,first_seen,last_seen) VALUES('sim-1','course-a','old-student','Old Student','old-student@example.invalid','2021-01-01T00:00:00.000Z','2021-01-02T00:00:00.000Z');",
  "INSERT OR IGNORE INTO identity_codes(deployment_id,course_id,user_id,user_code,scope,link_id,key_version) VALUES('sim-1','course-a','old-student','U_aaaaaaaaaaaaaaaaaaaaaaaaaaa','course','','v1');",
  "INSERT OR IGNORE INTO launches(id,token_fingerprint,event_time,deployment_id,institution,course_id,course_code,user_code,section_code,link_id,destination_origin,resource_link_id,status,redirect_status,key_version) VALUES('00000000-0000-4000-8000-000000000101','historical-test-fingerprint','2021-01-02T00:00:00.000Z','sim-1','sim-university','course-a','C_aaaaaaaaaaaaaaaaaaaaaaaaaaa','U_aaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL,'sim-activity-a','http://localhost:8788','resource:course-a:sim-activity-a','recorded','issued','v1');",
  "INSERT OR IGNORE INTO section_memberships(deployment_id,course_id,user_id,section_id,source) VALUES('sim-1','course-a','old-student','old-section','simulator');",
  "INSERT OR IGNORE INTO arrival_events(id,launch_id,link_id,event_type,observed_at,received_at,nonce) VALUES('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000101','sim-activity-a','opened','2021-01-02T00:00:00.000Z','2021-01-02T00:00:00.000Z','old_unique_nonce_for_retention_1');",
  "INSERT OR IGNORE INTO audit_events(id,time,deployment_id,course_id,actor_id,action,details) VALUES('00000000-0000-4000-8000-000000000103','2021-01-02T00:00:00.000Z','sim-1','course-a','teacher-1','retention-test','historical');",
  ''
].join('\n');
writeFileSync(join(root, 'bootstrap.sql'), bootstrap);
console.log('Test-only Canvas simulator keys and D1 seed data generated.');
console.log('Next: npm run db:local && npx wrangler d1 execute DB --local --file=.simulator/bootstrap.sql');
