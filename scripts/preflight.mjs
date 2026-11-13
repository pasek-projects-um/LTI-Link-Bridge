// Offline deployment-readiness checks. Never reads or prints secret values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function inspectDeployment(config, registration) {
  const issues=[];
  const vars=config?.vars||{};
  const url=typeof vars.PUBLIC_BASE_URL==='string'?vars.PUBLIC_BASE_URL:'';
  let base;
  try{
    base=new URL(url);
    if(base.protocol!=='https:')issues.push('PUBLIC_BASE_URL must use HTTPS');
    if(['localhost','127.0.0.1','[::1]'].includes(base.hostname))issues.push('PUBLIC_BASE_URL cannot be loopback');
    if(base.username||base.password||base.search||base.hash||base.pathname!=='/')issues.push('PUBLIC_BASE_URL must be a bare origin');
  }catch{issues.push('PUBLIC_BASE_URL is not a valid URL');}
  const db=config?.d1_databases?.find(x=>x.binding==='DB');
  if(!db)issues.push('D1 binding DB is missing');
  else if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id||'')||
    db.database_id==='00000000-0000-4000-8000-000000000001')
    issues.push('D1 database ID is a placeholder or invalid');
  if(!config?.name||!config?.main)issues.push('Worker name and entry point are required');
  const secretNames=['HMAC_KEY_V1','HMAC_KEY_V2','SESSION_SECRET','TOOL_PRIVATE_JWK','CANVAS_API_TOKENS'];
  for(const key of secretNames)if(Object.hasOwn(vars,key))issues.push(key+' must be a Worker secret, not a wrangler vars entry');
  if(vars.ENABLE_LOCAL_HTTP==='1')issues.push('ENABLE_LOCAL_HTTP cannot be enabled in a test/production deployment');
  if(vars.RETENTION_ENABLED==='1')issues.push('Educational-record retention is enabled; require separate institutional sign-off');
  if(registration){
    const values=['issuer','client_id','deployment_id','auth_url','jwks_url','institution'];
    for(const key of values)if(typeof registration[key]!=='string'||!registration[key].trim())issues.push('Registration missing '+key);
    for(const key of ['issuer','auth_url','jwks_url','canvas_api_origin']){
      const raw=registration[key];
      if(!raw)continue;
      try{const u=new URL(raw);if(u.protocol!=='https:')issues.push('Registration '+key+' must use HTTPS');
        if(['localhost','127.0.0.1','[::1]'].includes(u.hostname))issues.push('Registration '+key+' cannot use loopback');
        if(u.username||u.password)issues.push('Registration '+key+' cannot contain credentials');
        if((key==='issuer'||key==='canvas_api_origin')&&(u.pathname!=='/'||u.search||u.hash))issues.push('Registration '+key+' must be a bare origin');
      }catch{issues.push('Registration '+key+' is not a valid URL');}
    }
    if(base){
      for(const [key,path] of [['login_url','/lti/login'],['launch_url','/lti/launch'],['jwks_tool_url','/lti/jwks']]){
        if(registration[key]&&registration[key]!==new URL(path,base).toString())issues.push(key+' does not match PUBLIC_BASE_URL');
      }
    }
  }
  return issues;
}
function loadJson(path) {
  // Wrangler uses JSONC; only comment-free JSON is accepted by this check.
  return JSON.parse(readFileSync(resolve(path),'utf8'));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const cfg=args.indexOf('--config'),reg=args.indexOf('--registration');
  if(cfg<0||!args[cfg+1]){console.error('Usage: node scripts/preflight.mjs --config <production-wrangler.json> [--registration <non-secret-registration.json>]');process.exitCode=2;}
  else{
    try{
      const config=loadJson(args[cfg+1]);
      const registration=reg>=0?loadJson(args[reg+1]):null;
      const issues=inspectDeployment(config,registration);
      if(issues.length){for(const issue of issues)console.error('BLOCKER: '+issue);process.exitCode=1;}
      else console.log('Static preflight passed. This does NOT verify secrets, Canvas permissions, browser behavior, or institutional approval.');
    }catch(e){console.error('Preflight could not read inputs: '+e.message);process.exitCode=2;}
  }
}
