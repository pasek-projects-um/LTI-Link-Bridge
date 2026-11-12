import { LTI, INSTRUCTOR, ADMIN, randomId, urlToken, pseudonym, fingerprint, verifyPlatformJwt, signDeepLink, publicJwk, hmac } from './crypto.ts';
import { buildDestination, allowedDestination, escapeHtml } from './links.ts';

interface Env {
  DB: D1Database; HMAC_KEY_V1: string; SESSION_SECRET: string;
  TOOL_PRIVATE_JWK?: string; PUBLIC_BASE_URL: string; SESSION_TTL_SECONDS?: string;
  DESTINATION_ALLOWLIST?: string; ENABLE_LOCAL_HTTP?: string;
}
type Registration = {id:string;institution:string;issuer:string;client_id:string;deployment_id:string;auth_url:string;jwks_url:string};
type Launch = Record<string,any>;
const courseClaim = LTI + 'context';
const resourceClaim = LTI + 'resource_link';
const deploymentClaim = LTI + 'deployment_id';
const messageClaim = LTI + 'message_type';
const roleClaim = LTI + 'roles';
const deepClaim = 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings';
const cookieName='bridge_session';
const securityHeaders: Record<string,string> = {
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:*; frame-ancestors https: http://localhost:*; base-uri 'none'",
  'Cache-Control':'no-store',
};
function response(body:string, status=200, type='text/html; charset=utf-8', headers:Record<string,string>={}) {
  return new Response(body,{status,headers:{...securityHeaders,'Content-Type':type,...headers}});
}
function error(status:number, message:string) { return response(`<h1>${status}</h1><p>${escapeHtml(message)}</p>`,status); }
function html(title:string,body:string) {return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:1100px;margin:3rem auto;padding:0 1rem;color:#182234}nav{display:flex;gap:1rem;margin:1rem 0}a{color:#2451a0}input,select,button{padding:.55rem;margin:.3rem}table{border-collapse:collapse;width:100%}td,th{padding:.6rem;border-bottom:1px solid #ddd;text-align:left}label{display:block;margin:.4rem}section{padding:1rem;background:#f5f7fb;margin:1rem 0;border-radius:.4rem}</style><h1>${escapeHtml(title)}</h1>${body}</html>`;}
async function parseForm(req:Request) { const data=await req.formData(); return Object.fromEntries([...data].map(([k,v])=>[k,String(v)])); }
async function registration(env:Env,issuer:string,clientId:string):Promise<Registration|null> {
  return env.DB.prepare('SELECT * FROM deployments WHERE issuer=? AND client_id=? LIMIT 1').bind(issuer,clientId).first<Registration>();
}
function instructor(claims:Launch):boolean {const roles=claims[roleClaim];return Array.isArray(roles) && roles.some((r:string)=>r===INSTRUCTOR || r===ADMIN || r.endsWith('#Instructor') || r.endsWith('#Administrator'));}
function contextId(claims:Launch):string {const value=claims[courseClaim]?.id; if(typeof value!=='string' || !value) throw new Error('Missing course context');return value;}
function resourceId(claims:Launch):string {const value=claims[resourceClaim]?.id; if(typeof value!=='string' || !value) throw new Error('Missing resource link');return value;}
function cookieHeader(value:string,ttl:number,site:'None'|'Lax'='None') {return `${cookieName}=${value}; HttpOnly; Secure; SameSite=${site}; Path=/; Max-Age=${ttl}`;}
async function sessionCookie(env:Env,user:string,course:string,deploy:string,site:'None'|'Lax'='None'):Promise<string>{
  const ttl=Number(env.SESSION_TTL_SECONDS || '14400');const exp=Math.floor(Date.now()/1000)+ttl;
  const data=[user,course,deploy,String(exp)].map(encodeURIComponent).join('|');
  return cookieHeader(`${encodeURIComponent(data)}.${await hmac(env.SESSION_SECRET,'session',data)}`,ttl,site);
}
async function readSession(req:Request,env:Env):Promise<{user:string;course:string;deploy:string}|null>{
  const raw=req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!raw)return null;const last=raw.lastIndexOf('.');if(last<0)return null;
  const data=decodeURIComponent(raw.slice(0,last));const signature=raw.slice(last+1);
  if(signature!==await hmac(env.SESSION_SECRET,'session',data))return null;
  const [user,course,deploy,exp]=data.split('|').map(decodeURIComponent);
  if(!user||!course||!deploy||Number(exp)<Date.now()/1000)return null;
  return {user,course,deploy};
}
async function authorize(req:Request,env:Env,course:string,deploy:string) {
  const session=await readSession(req,env);
  if(!session || session.course!==course || session.deploy!==deploy)return null;
  const verified=await env.DB.prepare('SELECT user_id FROM instructors WHERE deployment_id=? AND course_id=? AND user_id=?').bind(deploy,course,session.user).first();
  return verified ? session : null;
}
async function makeInstructorTicket(env:Env,user:string,course:string,deploy:string,nextPath:string):Promise<string> {
  if(!nextPath.startsWith('/instructor') || nextPath.startsWith('//'))throw new Error('Invalid continuation path');
  const ticket=urlToken(32),expires=Math.floor(Date.now()/1000)+300;
  await env.DB.prepare('INSERT INTO instructor_tickets(ticket,deployment_id,course_id,user_id,next_path,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(ticket,deploy,course,user,nextPath,expires).run();
  return '/instructor/continue?ticket='+encodeURIComponent(ticket);
}
async function continueInstructor(req:Request,env:Env):Promise<Response> {
  const ticket=new URL(req.url).searchParams.get('ticket')||'';
  const stored=await env.DB.prepare('SELECT * FROM instructor_tickets WHERE ticket=?')
    .bind(ticket).first<{deployment_id:string;course_id:string;user_id:string;next_path:string;expires_at:number;consumed_at:number|null}>();
  const now=Math.floor(Date.now()/1000);
  if(!stored || stored.consumed_at!==null || stored.expires_at<now)return error(403,'Expired or reused instructor continuation');
  if(!stored.next_path.startsWith('/instructor') || stored.next_path.startsWith('//'))return error(403,'Invalid continuation');
  const changed=await env.DB.prepare('UPDATE instructor_tickets SET consumed_at=? WHERE ticket=? AND consumed_at IS NULL AND expires_at>=?')
    .bind(now,ticket,now).run();
  if(changed.meta.changes!==1)return error(403,'Instructor continuation already used');
  const cookie=await sessionCookie(env,stored.user_id,stored.course_id,stored.deployment_id,'Lax');
  return response('',303,'text/plain',{'Set-Cookie':cookie,'Location':stored.next_path});
}
async function login(req:Request,env:Env):Promise<Response>{
  const fields=req.method==='POST'?await parseForm(req):Object.fromEntries(new URL(req.url).searchParams);
  const issuer=fields.iss,clientId=fields.client_id,target=fields.target_link_uri;
  if(!issuer||!clientId||!target)return error(400,'Missing login initiation parameters');
  const deployment=await registration(env,issuer,clientId);
  if(!deployment)return error(403,'Unregistered platform/client');
  if(new URL(target).origin !== new URL(env.PUBLIC_BASE_URL).origin || new URL(target).pathname!=='/lti/launch')return error(400,'Invalid target URI');
  const state=urlToken();const nonce=urlToken();const now=Math.floor(Date.now()/1000);
  await env.DB.prepare('INSERT INTO oidc_states(state,nonce,deployment_id,created_at,expires_at) VALUES(?,?,?,?,?)').bind(state,nonce,deployment.id,now,now+600).run();
  const redirect=new URL(deployment.auth_url);
  redirect.searchParams.set('scope','openid');redirect.searchParams.set('response_type','id_token');redirect.searchParams.set('response_mode','form_post');
  redirect.searchParams.set('prompt','none');redirect.searchParams.set('client_id',deployment.client_id);
  redirect.searchParams.set('redirect_uri',new URL('/lti/launch',env.PUBLIC_BASE_URL).toString());
  redirect.searchParams.set('state',state);redirect.searchParams.set('nonce',nonce);
  if(fields.login_hint)redirect.searchParams.set('login_hint',fields.login_hint);
  if(fields.lti_message_hint)redirect.searchParams.set('lti_message_hint',fields.lti_message_hint);
  return Response.redirect(redirect.toString(),302);
}
async function verifyLaunch(req:Request,env:Env) {
  const form=await parseForm(req);const state=form.state,idToken=form.id_token;
  if(!state||!idToken)throw new Error('Missing state/token');
  const stored=await env.DB.prepare('SELECT * FROM oidc_states WHERE state=?').bind(state).first<{nonce:string;deployment_id:string;expires_at:number;consumed_at:number|null}>();
  if(!stored || stored.consumed_at!==null || stored.expires_at<Math.floor(Date.now()/1000))throw new Error('Expired or reused OIDC state');
  const registration=await env.DB.prepare('SELECT * FROM deployments WHERE id=?').bind(stored.deployment_id).first<Registration>();
  if(!registration)throw new Error('Unknown deployment');
  const claims=await verifyPlatformJwt(idToken,registration,stored.nonce) as Launch;
  // Multiple LTI deployments can share the same issuer and client ID.
  // Resolve the actual deployment from the *verified* signed claim rather than
  // selecting whichever registration SQLite happened to return at OIDC start.
  const claimedDeployment=claims[deploymentClaim];
  if(typeof claimedDeployment!=='string' || !claimedDeployment)throw new Error('Missing deployment claim');
  const actualRegistration=await env.DB.prepare('SELECT * FROM deployments WHERE issuer=? AND client_id=? AND deployment_id=?')
    .bind(registration.issuer,registration.client_id,claimedDeployment).first<Registration>();
  if(!actualRegistration)throw new Error('Deployment mismatch');
  if(actualRegistration.jwks_url!==registration.jwks_url || actualRegistration.auth_url!==registration.auth_url)
    throw new Error('Inconsistent platform registration for deployment');
  if(claims[LTI+'version']!=='1.3.0')throw new Error('Unsupported LTI version');
  if(!['LtiResourceLinkRequest','LtiDeepLinkingRequest'].includes(claims[messageClaim]))throw new Error('Unsupported LTI message type');
  if(!Array.isArray(claims[roleClaim]))throw new Error('Missing LTI roles');
  const change=await env.DB.prepare('UPDATE oidc_states SET consumed_at=? WHERE state=? AND consumed_at IS NULL AND expires_at>=?').bind(Math.floor(Date.now()/1000),state,Math.floor(Date.now()/1000)).run();
  if(change.meta.changes!==1)throw new Error('Replayed LTI state');
  return {claims,registration:actualRegistration,token:idToken};
}
function getLinkId(claims:Launch):string | null {
  const custom=claims[LTI+'custom'];
  return typeof custom?.bridge_link_id==='string' ? custom.bridge_link_id : null;
}
async function handleResource(env:Env,claims:Launch,reg:Registration,token:string):Promise<Response>{
  const course=contextId(claims),resource=resourceId(claims),user=String(claims.sub);
  const configured=getLinkId(claims);
  const link=configured
    ? await env.DB.prepare('SELECT * FROM links WHERE id=? AND course_id=? AND deployment_id=?').bind(configured,course,reg.id).first<Launch>()
    : await env.DB.prepare('SELECT links.* FROM links JOIN link_resources r ON r.link_id=links.id WHERE r.deployment_id=? AND r.course_id=? AND r.resource_link_id=?').bind(reg.id,course,resource).first<Launch>();
  if(!link)return error(403,'Resource link has no authorized destination');
  const bound=await env.DB.prepare('SELECT link_id FROM link_resources WHERE deployment_id=? AND course_id=? AND resource_link_id=?').bind(reg.id,course,resource).first<{link_id:string}>();
  if(bound && bound.link_id!==link.id)return error(403,'Conflicting resource binding');
  if(!bound)await env.DB.prepare('INSERT OR IGNORE INTO link_resources(deployment_id,course_id,resource_link_id,link_id) VALUES(?,?,?,?)').bind(reg.id,course,resource,link.id).run();
  if(!allowedDestination(link.destination,env.DESTINATION_ALLOWLIST||''))return error(403,'Destination domain is not approved');
  if(!env.ENABLE_LOCAL_HTTP && new URL(link.destination).protocol!=='https:')return error(403,'HTTP destinations disabled');
  const version='v1';const secret=env.HMAC_KEY_V1;
  const base=[reg.institution,reg.issuer,reg.client_id,reg.deployment_id];
  const courseCode=await pseudonym(secret,'C',version,...base,course);
  const userParts=link.user_scope==='global'?[user]:link.user_scope==='activity'?[course,link.id,user]:[course,user];
  const userCode=await pseudonym(secret,'U',version,...base,link.user_scope,...userParts);
  const membership=await env.DB.prepare('SELECT section_id FROM section_memberships WHERE deployment_id=? AND course_id=? AND user_id=? ORDER BY section_id LIMIT 1').bind(reg.id,course,user).first<{section_id:string}>();
  const sectionCode=membership?await pseudonym(secret,'S',version,...base,membership.section_id):null;
  if(link.forward_section && link.section_required && !sectionCode)return error(409,'Section membership unresolved');
  const eventId=randomId(),at=new Date().toISOString(),origin=new URL(link.destination).origin;
  const target=buildDestination(link.destination,{
    user:link.forward_user?userCode:undefined,course:link.forward_course?courseCode:undefined,
    section:link.forward_section?sectionCode||undefined:undefined,
    link:link.forward_link?link.id:undefined,launch:link.forward_launch?eventId:undefined
  });
  const fp=await fingerprint(token);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO identities(deployment_id,course_id,user_id,full_name,email,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)').bind(reg.id,course,user,typeof claims.name==='string'?claims.name:null,typeof claims.email==='string'?claims.email:null,at,at),
      env.DB.prepare('UPDATE identities SET last_seen=? WHERE deployment_id=? AND course_id=? AND user_id=?').bind(at,reg.id,course,user),
      env.DB.prepare('INSERT OR IGNORE INTO identity_codes(deployment_id,course_id,user_id,user_code,scope,link_id,key_version) VALUES(?,?,?,?,?,?,?)').bind(reg.id,course,user,userCode,link.user_scope,link.user_scope==='activity'?link.id:'',version),
      env.DB.prepare('INSERT OR IGNORE INTO launches(id,token_fingerprint,event_time,deployment_id,institution,course_id,course_code,user_code,section_code,link_id,destination_origin,resource_link_id,status,redirect_status,key_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(eventId,fp,at,reg.id,reg.institution,course,courseCode,userCode,sectionCode,link.id,origin,resource,'recorded','issued',version)
    ]);
  }catch {return error(503,'Launch could not be logged; destination not opened');}
  const existing=await env.DB.prepare('SELECT id FROM launches WHERE token_fingerprint=?').bind(fp).first<{id:string}>();
  if(existing?.id!==eventId)return error(409,'This LTI token has already been processed; launch again from Canvas');
  return response('',303,'text/plain',{'Location':target});
}
async function handleDeepLink(req:Request,env:Env,claims:Launch,reg:Registration):Promise<Response>{
  if(!instructor(claims))return error(403,'Instructor role required');
  const course=contextId(claims),user=String(claims.sub),settings=claims[deepClaim];
  if(!settings || typeof settings.deep_link_return_url!=='string')return error(400,'Missing deep linking settings');
  const now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO instructors(deployment_id,course_id,user_id,last_verified_at) VALUES(?,?,?,?) ON CONFLICT(deployment_id,course_id,user_id) DO UPDATE SET last_verified_at=excluded.last_verified_at').bind(reg.id,course,user,now).run();
  const cookie=await sessionCookie(env,user,course,reg.id);
  const returnData=typeof settings.data==='string'?settings.data:'';
  const challenge=await hmac(env.SESSION_SECRET,'deep',reg.id,course,user,settings.deep_link_return_url,returnData);
  const url=new URL(req.url);url.pathname='/instructor/create';
  url.search='';url.searchParams.set('course',course);url.searchParams.set('deployment',reg.id);
  url.searchParams.set('return',settings.deep_link_return_url);
  url.searchParams.set('data',returnData);
  url.searchParams.set('csrf',challenge);
  const resume=await makeInstructorTicket(env,user,course,reg.id,url.pathname+url.search);
  return response(html('Configure a Canvas link',`<p>Open the Canvas link builder in a new tab to avoid third-party cookie restrictions.</p><a href="${escapeHtml(resume)}" target="_blank" rel="noopener">Create link</a>`),200,'text/html; charset=utf-8',{'Set-Cookie':cookie});
}
async function launch(req:Request,env:Env):Promise<Response>{
  let parsed;
  try{parsed=await verifyLaunch(req,env);}catch(e){return error(403,`LTI authentication failed: ${e instanceof Error?e.message:'invalid token'}`);}
  const {claims,registration:reg,token}=parsed;
  try {
    if(claims[messageClaim]==='LtiDeepLinkingRequest')return await handleDeepLink(req,env,claims,reg);
    if(instructor(claims)){
      const course=contextId(claims),user=String(claims.sub),at=new Date().toISOString();
      await env.DB.prepare('INSERT INTO instructors(deployment_id,course_id,user_id,last_verified_at) VALUES(?,?,?,?) ON CONFLICT(deployment_id,course_id,user_id) DO UPDATE SET last_verified_at=excluded.last_verified_at').bind(reg.id,course,user,at).run();
    }
    if(claims[messageClaim]==='LtiResourceLinkRequest' && getLinkId(claims))return await handleResource(env,claims,reg,token);
    if(!instructor(claims))return error(403,'No configured student resource link');
    const course=contextId(claims);const cookie=await sessionCookie(env,String(claims.sub),course,reg.id);
    const nextPath=`/instructor?course=${encodeURIComponent(course)}&deployment=${encodeURIComponent(reg.id)}`;
    const resume=await makeInstructorTicket(env,String(claims.sub),course,reg.id,nextPath);
    return response(html('Instructor dashboard',`<p>Open the dashboard in a new tab to avoid Canvas iframe cookie restrictions.</p><a href="${escapeHtml(resume)}" target="_blank" rel="noopener">Open course dashboard</a>`),200,'text/html; charset=utf-8',{'Set-Cookie':cookie});
  }catch(e){return error(500,e instanceof Error?e.message:'Unexpected launch error');}
}
async function dashboard(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url),course=url.searchParams.get('course')||'',deploy=url.searchParams.get('deployment')||'';
  const session=await authorize(req,env,course,deploy);if(!session)return error(403,'Verified instructor session required');
  const filterLink=url.searchParams.get('link')||'',filterUser=url.searchParams.get('user')||'',since=url.searchParams.get('since')||'',until=url.searchParams.get('until')||'';
  const page=Math.max(1,Math.min(100000,Number(url.searchParams.get('page')||1)||1));
  const where=['l.deployment_id=?','l.course_id=?'];const values:unknown[]=[deploy,course];
  if(filterLink){where.push('l.link_id=?');values.push(filterLink);}
  if(filterUser){where.push('l.user_code=?');values.push(filterUser);}
  if(since){where.push('l.event_time>=?');values.push(since);}
  if(until){where.push('l.event_time<=?');values.push(until);}
  const clause=where.join(' AND ');
  const counts=await env.DB.prepare(`SELECT COUNT(*) AS total,COUNT(DISTINCT user_code) AS students,COUNT(DISTINCT link_id) AS links,MIN(event_time) AS first_launch,MAX(event_time) AS last_launch FROM launches l WHERE ${clause}`).bind(...values).first<Record<string,unknown>>();
  const rows=await env.DB.prepare(`SELECT l.id,l.event_time,l.user_code,l.link_id,links.title,l.section_code,l.redirect_status FROM launches l JOIN links ON links.id=l.link_id WHERE ${clause} ORDER BY l.event_time DESC LIMIT 100 OFFSET ?`).bind(...values,(page-1)*100).all<Record<string,unknown>>();
  const links=await env.DB.prepare('SELECT id,title FROM links WHERE deployment_id=? AND course_id=? ORDER BY created_at DESC').bind(deploy,course).all<{id:string;title:string}>();
  const byDay=await env.DB.prepare('SELECT substr(l.event_time,1,10) AS day,COUNT(*) AS total FROM launches l WHERE '+clause+' GROUP BY substr(l.event_time,1,10) ORDER BY day DESC LIMIT 30').bind(...values).all<{day:string;total:number}>();
  const byActivity=await env.DB.prepare('SELECT l.link_id,links.title,COUNT(*) AS total,COUNT(DISTINCT l.user_code) AS students FROM launches l JOIN links ON links.id=l.link_id WHERE '+clause+' GROUP BY l.link_id,links.title ORDER BY total DESC,links.title LIMIT 100').bind(...values).all<{link_id:string;title:string;total:number;students:number}>();
  const byStudent=await env.DB.prepare('SELECT l.user_code,COUNT(*) AS total,COUNT(DISTINCT l.link_id) AS activities,MIN(l.event_time) AS first_launch,MAX(l.event_time) AS last_launch FROM launches l WHERE '+clause+' GROUP BY l.user_code ORDER BY total DESC,l.user_code LIMIT 100').bind(...values).all<{user_code:string;total:number;activities:number;first_launch:string;last_launch:string}>();

  const base=`course=${encodeURIComponent(course)}&deployment=${encodeURIComponent(deploy)}`;
  const linkOptions=links.results.map(l=>`<option value="${escapeHtml(l.id)}" ${filterLink===l.id?'selected':''}>${escapeHtml(l.title)}</option>`).join('');
  const tbody=rows.results.map(r=>`<tr><td>${escapeHtml(r.event_time)}</td><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.user_code)}</td><td>${escapeHtml(r.section_code||'unresolved')}</td><td>${escapeHtml(r.redirect_status)}</td></tr>`).join('');
  const summaryByDay=byDay.results.map(r=>'<tr><td>'+escapeHtml(r.day)+'</td><td>'+escapeHtml(r.total)+'</td></tr>').join('');
  const summaryByActivity=byActivity.results.map(r=>'<tr><td><a href="/instructor?'+base+'&link='+encodeURIComponent(r.link_id)+'">'+escapeHtml(r.title)+'</a></td><td>'+escapeHtml(r.total)+'</td><td>'+escapeHtml(r.students)+'</td></tr>').join('');
  const summaryByStudent=byStudent.results.map(r=>'<tr><td><a href="/instructor?'+base+'&user='+encodeURIComponent(r.user_code)+'">'+escapeHtml(r.user_code)+'</a></td><td>'+escapeHtml(r.total)+'</td><td>'+escapeHtml(r.activities)+'</td><td>'+escapeHtml(r.last_launch)+'</td></tr>').join('');
  const tables='<section><h2>Launches by day (UTC)</h2><table><tr><th>Day</th><th>Launches</th></tr>'+summaryByDay+'</table></section>'+
    '<section><h2>Activity summary</h2><table><tr><th>Activity</th><th>Launches</th><th>Unique students</th></tr>'+summaryByActivity+'</table></section>'+
    '<section><h2>Student summary</h2><table><tr><th>Pseudonymous user</th><th>Launches</th><th>Activities</th><th>Last launch (UTC)</th></tr>'+summaryByStudent+'</table><small>Top 100 students by launch count; filter the student code to view the complete history.</small></section>';

  const filter=`<form method="get"><input type="hidden" name="course" value="${escapeHtml(course)}"><input type="hidden" name="deployment" value="${escapeHtml(deploy)}"><label>Activity <select name="link"><option value="">All</option>${linkOptions}</select></label><label>Student code <input name="user" value="${escapeHtml(filterUser)}"></label><label>From UTC <input name="since" placeholder="2026-01-01T00:00:00Z" value="${escapeHtml(since)}"></label><label>Until UTC <input name="until" placeholder="2026-12-31T23:59:59Z" value="${escapeHtml(until)}"></label><button>Filter</button></form>`;
  const exports=`<p><a href="/instructor/export?${base}&type=launches">Export all launches (CSV)</a> · <a href="/instructor/export?${base}&type=identities">Export identity mapping (CSV)</a></p>`;
  const next=new URL(url);next.searchParams.set('page',String(page+1));
  return response(html('LTI Link Bridge · Course dashboard',`<nav><a href="/instructor/create?${base}">Create link</a> <a href="/instructor/sections?${base}">Manage sections</a></nav><section><b>${counts?.total||0}</b> launches · <b>${counts?.students||0}</b> students · <b>${counts?.links||0}</b> activities<br>First ${escapeHtml(counts?.first_launch||'—')} · Last ${escapeHtml(counts?.last_launch||'—')}</section>${filter}${exports}${tables}<h2>Chronological launch history</h2><table><tr><th>Timestamp (UTC)</th><th>Activity</th><th>Student code</th><th>Section</th><th>Redirect</th></tr>${tbody}</table><p>Page ${page} · <a href="${escapeHtml(next.pathname+next.search)}">Next page</a></p>`));
}
// Export every row using stable keyset pagination, rather than silently
// truncating education records at an arbitrary LIMIT.
async function exportCsv(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url),course=url.searchParams.get('course')||'',deploy=url.searchParams.get('deployment')||'';
  const session=await authorize(req,env,course,deploy);
  if(!session)return error(403,'Instructor access required');
  const exportType=url.searchParams.get('type')||'launches';
  if(!['launches','identities'].includes(exportType))return error(400,'Unsupported CSV export');
  const identities=exportType==='identities';
  const link=url.searchParams.get('link')||'',user=url.searchParams.get('user')||'';
  const since=url.searchParams.get('since')||'',until=url.searchParams.get('until')||'';
  const columns=identities
    ? ['user_id','full_name','email','user_code','scope','link_id','key_version','section_ids','first_seen','last_seen']
    : ['id','event_time','institution','deployment_id','course_id','course_code','user_code','section_code','link_id','destination_origin','resource_link_id','status','redirect_status','error_code','key_version'];
  if(identities){
    const auditDetails=JSON.stringify({scope:'identity_mapping',link:link||null,user:user||null});
    await env.DB.prepare('INSERT INTO audit_events(id,time,deployment_id,course_id,actor_id,action,details) VALUES(?,?,?,?,?,?,?)')
      .bind(randomId(),new Date().toISOString(),deploy,course,session.user,'identity_export',auditDetails).run();
  }
  const encoder=new TextEncoder();
  let lastTime='',lastId='',lastUser='',lastCode='',finished=false;
  const stream=new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(encoder.encode(columns.join(',')+'\r\n'));},
    async pull(controller){
      if(finished){controller.close();return;}
      try {
        let query:string;
        const values:unknown[]=[deploy,course];
        if(identities){
          const where=['i.deployment_id=?','i.course_id=?'];
          if(user){where.push('c.user_code=?');values.push(user);}
          if(link){where.push('c.link_id=?');values.push(link);}
          if(lastUser){where.push('(i.user_id>? OR (i.user_id=? AND c.user_code>?))');values.push(lastUser,lastUser,lastCode);}
          query='SELECT i.user_id,i.full_name,i.email,c.user_code,c.scope,c.link_id,c.key_version,'+
            '(SELECT group_concat(m.section_id, \';\') FROM section_memberships m WHERE m.deployment_id=i.deployment_id AND m.course_id=i.course_id AND m.user_id=i.user_id) AS section_ids,'+
            'i.first_seen,i.last_seen FROM identities i JOIN identity_codes c ON c.deployment_id=i.deployment_id AND c.course_id=i.course_id AND c.user_id=i.user_id '+
            'WHERE '+where.join(' AND ')+' ORDER BY i.user_id,c.user_code LIMIT 400';
        }else{
          const where=['deployment_id=?','course_id=?'];
          if(user){where.push('user_code=?');values.push(user);}
          if(link){where.push('link_id=?');values.push(link);}
          if(since){where.push('event_time>=?');values.push(since);}
          if(until){where.push('event_time<=?');values.push(until);}
          if(lastTime){where.push('(event_time>? OR (event_time=? AND id>?))');values.push(lastTime,lastTime,lastId);}
          query='SELECT '+columns.join(',')+' FROM launches WHERE '+where.join(' AND ')+' ORDER BY event_time,id LIMIT 400';
        }
        const rows=(await env.DB.prepare(query).bind(...values).all<Record<string,unknown>>()).results;
        if(rows.length===0){finished=true;controller.close();return;}
        controller.enqueue(encoder.encode(rows.map(r=>columns.map(c=>csvCell(r[c])).join(',')).join('\r\n')+'\r\n'));
        if(identities){
          const last=rows[rows.length-1];lastUser=String(last.user_id);lastCode=String(last.user_code);
        }else{
          const last=rows[rows.length-1];lastTime=String(last.event_time);lastId=String(last.id);
        }
        if(rows.length<400){finished=true;controller.close();}
      }catch(e){controller.error(e);}
    }
  });
  return new Response(stream,{status:200,headers:{...securityHeaders,'Content-Type':'text/csv; charset=utf-8',
    'Content-Disposition':'attachment; filename="bridge-'+exportType+'.csv"'}});
}
function csvCell(value:unknown):string{
  const raw=String(value??'');
  const neutral=/^\s*[=+\-@]/.test(raw)?"'"+raw:raw;
  return '"'+neutral.replace(/"/g,'""')+'"';
}
// Instructor-managed section membership fallback. A user must first have a
// cryptographically verified LTI launch before the instructor can map them.
async function manageSections(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url);
  const fields=req.method==='POST'?await parseForm(req):Object.fromEntries(url.searchParams);
  const course=fields.course||'',deploy=fields.deployment||'';
  const session=await authorize(req,env,course,deploy);
  if(!session)return error(403,'Verified instructor access required');
  const csrf=await hmac(env.SESSION_SECRET,'sections',deploy,course,session.user);
  if(req.method==='POST'){
    const origin=req.headers.get('origin');
    if(origin&&origin!==url.origin)return error(403,'Cross-origin section update refused');
    if(fields.csrf!==csrf)return error(403,'Invalid section form token');
    const user=(fields.user_id||'').trim(),section=(fields.section_id||'').trim();
    if(!user||!section||user.length>150||section.length>150||/[\r\n\0]/.test(user+section))
      return error(400,'Invalid user or section identifier');
    const found=await env.DB.prepare('SELECT user_id FROM identities WHERE deployment_id=? AND course_id=? AND user_id=?')
      .bind(deploy,course,user).first();
    if(!found)return error(400,'Student must first launch through verified LTI before a section can be assigned');
    if(fields.action==='remove'){
      await env.DB.prepare("DELETE FROM section_memberships WHERE deployment_id=? AND course_id=? AND user_id=? AND section_id=? AND source='instructor'")
        .bind(deploy,course,user,section).run();
    }else if(fields.action==='add'){
      await env.DB.prepare("INSERT OR IGNORE INTO section_memberships(deployment_id,course_id,user_id,section_id,source) VALUES(?,?,?,?,'instructor')")
        .bind(deploy,course,user,section).run();
    }else return error(400,'Unknown section operation');
    await env.DB.prepare('INSERT INTO audit_events(id,time,deployment_id,course_id,actor_id,action,details) VALUES(?,?,?,?,?,?,?)')
      .bind(randomId(),new Date().toISOString(),deploy,course,session.user,'section_'+fields.action,JSON.stringify({user,section})).run();
    return response('',303,'text/plain',{'Location':'/instructor/sections?course='+encodeURIComponent(course)+'&deployment='+encodeURIComponent(deploy)});
  }
  const all=await env.DB.prepare(
    "SELECT i.user_id,i.full_name,i.email, "+
    "(SELECT group_concat(m.section_id, '; ') FROM section_memberships m "+
    "WHERE m.deployment_id=i.deployment_id AND m.course_id=i.course_id AND m.user_id=i.user_id) AS section_ids "+
    "FROM identities i WHERE i.deployment_id=? AND i.course_id=? ORDER BY i.user_id LIMIT 500"
  ).bind(deploy,course).all<Record<string,unknown>>();
  const rows=all.results.map(row=>'<tr><td>'+escapeHtml(row.user_id)+'</td><td>'+escapeHtml(row.full_name||'not released')+'</td><td>'+escapeHtml(row.section_ids||'unresolved')+'</td></tr>').join('');
  const base='<input type="hidden" name="course" value="'+escapeHtml(course)+'"><input type="hidden" name="deployment" value="'+escapeHtml(deploy)+'"><input type="hidden" name="csrf" value="'+csrf+'">';
  const form='<form method="post">'+base+
    '<label>Verified Canvas user ID <input name="user_id" required maxlength="150"></label>'+
    '<label>Canvas section ID (instructor supplied) <input name="section_id" required maxlength="150"></label>'+
    '<button name="action" value="add">Add membership</button> <button name="action" value="remove">Remove instructor mapping</button></form>';
  return response(html('Instructor section mappings',
    '<p><a href="/instructor?course='+encodeURIComponent(course)+'&deployment='+encodeURIComponent(deploy)+'">Back to dashboard</a></p>'+
    '<p>Students must first launch an activity before section mapping. Multiple section memberships are supported. This manual mapping has not been verified against the Canvas API. The default forwarding policy selects the lexicographically first mapped section ID.</p>'+
    form+'<h2>Observed students and sections</h2><table><tr><th>Canvas user ID</th><th>Name</th><th>Section IDs</th></tr>'+rows+'</table>'+
    '<p>Showing up to 500 observed students. This interface never exposes mappings to students or destination websites.</p>'));
}
async function createLink(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url),form=req.method==='POST'?await parseForm(req):Object.fromEntries(url.searchParams);
  const course=form.course||'',deploy=form.deployment||'';
  const session=await authorize(req,env,course,deploy);if(!session)return error(403,'Instructor access required');
  const returnUrl=form.return||'',data=form.data||'';
  const expected=returnUrl?await hmac(env.SESSION_SECRET,'deep',deploy,course,session.user,returnUrl,data):'';
  if(req.method==='POST'){
    const origin=req.headers.get('origin');if(origin && origin!==url.origin)return error(403,'Cross-site request rejected');
    if(form.csrf!==await hmac(env.SESSION_SECRET,'create',deploy,course,session.user,returnUrl,data))return error(403,'Invalid form token');
    if(!form.title?.trim()||!form.destination)return error(400,'Title and destination required');
    if(!allowedDestination(form.destination,env.DESTINATION_ALLOWLIST||'') || (!env.ENABLE_LOCAL_HTTP&&new URL(form.destination).protocol!=='https:'))return error(400,'Unapproved destination');
    if(returnUrl && !env.TOOL_PRIVATE_JWK)return error(503,'Deep Linking signing key not configured');
    if(returnUrl){const target=new URL(returnUrl);if(target.protocol!=='https:' && !(env.ENABLE_LOCAL_HTTP && ['localhost','127.0.0.1'].includes(target.hostname)))return error(400,'Invalid Deep Linking return URL');}
    const scope=['global','course','activity'].includes(form.scope)?form.scope:'course';const id=randomId();
    await env.DB.prepare('INSERT INTO links(id,deployment_id,course_id,title,destination,user_scope,forward_user,forward_course,forward_section,forward_link,forward_launch,section_required,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,deploy,course,form.title.trim(),form.destination,scope,form.user==='on'?1:0,form.course_code==='on'?1:0,form.section==='on'?1:0,form.link==='on'?1:0,form.launch==='on'?1:0,form.section_required==='on'?1:0,session.user,new Date().toISOString()).run();
    if(returnUrl){
      if(!env.TOOL_PRIVATE_JWK)return error(503,'Deep Linking signing key not configured');
      const reg=await env.DB.prepare('SELECT * FROM deployments WHERE id=?').bind(deploy).first<Registration>();if(!reg)return error(404,'Deployment missing');
      const token=await signDeepLink(env.TOOL_PRIVATE_JWK,reg.client_id,reg.issuer,{
        [LTI+'version']:'1.3.0',[LTI+'message_type']:'LtiDeepLinkingResponse',
        [deploymentClaim]:reg.deployment_id,
        ['https://purl.imsglobal.org/spec/lti-dl/claim/content_items']:[{type:'ltiResourceLink',title:form.title.trim(),url:new URL('/lti/launch',env.PUBLIC_BASE_URL).toString(),custom:{bridge_link_id:id}}],
        ['https://purl.imsglobal.org/spec/lti-dl/claim/data']:data
      });
      const destination=new URL(returnUrl);
      if(destination.protocol!=='https:' && !(env.ENABLE_LOCAL_HTTP && destination.hostname==='localhost'))return error(400,'Invalid deep link return URL');
      return response(html('Return to Canvas',`<form id="return" method="post" action="${escapeHtml(destination.toString())}"><input type="hidden" name="JWT" value="${escapeHtml(token)}"><button>Return link to Canvas</button></form>`));
    }
    return response(html('Link saved',`<p>Saved ${escapeHtml(form.title)}. Link ID: <code>${escapeHtml(id)}</code></p><a href="/instructor?course=${encodeURIComponent(course)}&deployment=${encodeURIComponent(deploy)}">Dashboard</a>`));
  }
  if(returnUrl&&form.csrf!==expected)return error(403,'Invalid Deep Linking context');
  const csrf=await hmac(env.SESSION_SECRET,'create',deploy,course,session.user,returnUrl,data);
  const checked=(name:string,yes:boolean)=>`<label><input type="checkbox" name="${name}" ${yes?'checked':''}> Forward ${name}</label>`;
  return response(html('Create external activity link',`<form method="post"><input type="hidden" name="course" value="${escapeHtml(course)}"><input type="hidden" name="deployment" value="${escapeHtml(deploy)}"><input type="hidden" name="return" value="${escapeHtml(returnUrl)}"><input type="hidden" name="data" value="${escapeHtml(data)}"><input type="hidden" name="csrf" value="${csrf}"><label>Activity name <input name="title" required maxlength="120"></label><label>Destination URL <input name="destination" type="url" required size="70" placeholder="https://example.edu/activity"></label><label>User code scope <select name="scope"><option value="course">Within course (default)</option><option value="global">Global within deployment</option><option value="activity">Within activity</option></select></label>${checked('user',true)}${checked('course_code',true)}${checked('section',false)}${checked('link',true)}${checked('launch',true)}<label><input type="checkbox" name="section_required"> Require resolved section to launch</label><button>Save ${returnUrl?'and return to Canvas':''}</button></form>`));
}
export default {
  async fetch(req:Request,env:Env):Promise<Response>{
    try{
      const path=new URL(req.url).pathname;
      if(path==='/health')return response(JSON.stringify({status:'ok'}),200,'application/json');
      if(path==='/lti/jwks')return env.TOOL_PRIVATE_JWK?response(JSON.stringify({keys:[publicJwk(env.TOOL_PRIVATE_JWK)]}),200,'application/json'):error(503,'Signing key unavailable');
      if(path==='/lti/login'&&['GET','POST'].includes(req.method))return login(req,env);
      if(path==='/lti/launch'&&req.method==='POST')return launch(req,env);
      if(path==='/instructor/continue'&&req.method==='GET')return continueInstructor(req,env);
      if(path==='/instructor'&&req.method==='GET')return dashboard(req,env);
      if(path==='/instructor/sections'&&['GET','POST'].includes(req.method))return manageSections(req,env);
      if(path==='/instructor/create'&&['GET','POST'].includes(req.method))return createLink(req,env);
      if(path==='/instructor/export'&&req.method==='GET')return exportCsv(req,env);
      if(path==='/')return response(html('LTI Link Bridge','<p>Launch from your learning management system to access this tool.</p>'));
      return error(404,'Not found');
    }catch(e){return error(500,e instanceof Error?e.message:'Unhandled server error');}
  }
} satisfies ExportedHandler<Env>;
