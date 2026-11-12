interface RetentionEnv {
  DB:D1Database; RETENTION_ENABLED?:string;
  RETENTION_LAUNCH_DAYS?:string; RETENTION_IDENTITY_DAYS?:string; RETENTION_AUDIT_DAYS?:string;
}
function days(name:string,value:string|undefined,minimum:number):number{
  if(!value||!/^[0-9]+$/.test(value))throw new Error(name+' must be explicitly configured');
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<minimum||number>3650)throw new Error(name+' outside safe bounds');
  return number;
}
const cutoff=(now:number,days:number)=>new Date(now-days*86400000).toISOString();
// The cleanup is deliberately bounded per scheduled invocation so a large course
// cannot exhaust D1 execution limits. It is disabled for education records until
// institution-approved policy values are explicitly provisioned.
export async function runRetention(env:RetentionEnv,now=Date.now()):Promise<void>{
  const unix=Math.floor(now/1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oidc_states WHERE state IN (SELECT state FROM oidc_states WHERE expires_at<? LIMIT 1000)').bind(unix),
    env.DB.prepare('DELETE FROM instructor_tickets WHERE ticket IN (SELECT ticket FROM instructor_tickets WHERE expires_at<? LIMIT 1000)').bind(unix)
  ]);
  if(env.RETENTION_ENABLED!=='1')return;
  const launchDays=days('RETENTION_LAUNCH_DAYS',env.RETENTION_LAUNCH_DAYS,30);
  const identityDays=days('RETENTION_IDENTITY_DAYS',env.RETENTION_IDENTITY_DAYS,launchDays);
  const auditDays=days('RETENTION_AUDIT_DAYS',env.RETENTION_AUDIT_DAYS,identityDays);
  const launchCutoff=cutoff(now,launchDays);
  const identityCutoff=cutoff(now,identityDays);
  const auditCutoff=cutoff(now,auditDays);
  const oldestLaunches="SELECT id FROM launches WHERE event_time<? ORDER BY event_time,id LIMIT 300";
  const oldestIdentities="SELECT i.deployment_id,i.course_id,i.user_id FROM identities i "+
    "WHERE i.last_seen<? AND NOT EXISTS (SELECT 1 FROM launches l WHERE l.deployment_id=i.deployment_id "+
    "AND l.course_id=i.course_id AND EXISTS (SELECT 1 FROM identity_codes c "+
    "WHERE c.deployment_id=i.deployment_id AND c.course_id=i.course_id AND c.user_id=i.user_id "+
    "AND c.user_code=l.user_code)) "+
    "ORDER BY i.last_seen,i.user_id LIMIT 300";
  await env.DB.batch([
    env.DB.prepare('DELETE FROM arrival_events WHERE launch_id IN ('+oldestLaunches+')').bind(launchCutoff),
    env.DB.prepare('DELETE FROM launches WHERE id IN ('+oldestLaunches+')').bind(launchCutoff)
  ]);
  // Delete the protected identity data only when the student has no remaining
  // launch in any of their recorded identifier scopes in this course.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM section_memberships WHERE (deployment_id,course_id,user_id) IN ('+oldestIdentities+')').bind(identityCutoff),
    env.DB.prepare('DELETE FROM identity_codes WHERE (deployment_id,course_id,user_id) IN ('+oldestIdentities+')').bind(identityCutoff),
    env.DB.prepare('DELETE FROM identities WHERE (deployment_id,course_id,user_id) IN ('+oldestIdentities+')').bind(identityCutoff)
  ]);
  await env.DB.prepare('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE time<? ORDER BY time,id LIMIT 300)').bind(auditCutoff).run();
}
