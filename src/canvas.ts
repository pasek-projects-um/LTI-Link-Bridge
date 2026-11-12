export interface CanvasConfig {
  id:string; canvas_api_origin?:string|null;
}
export interface CanvasRuntime {
  CANVAS_API_TOKENS?:string;
  PUBLIC_BASE_URL:string;
  ENABLE_LOCAL_HTTP?:string;
}
export interface CanvasMembership {
  section_id:string; source:'canvas';
}
const validId=(id:string)=>/^[A-Za-z0-9_-]{1,150}$/.test(id);
export function canvasEndpoint(reg:CanvasConfig,course:string,user:string,env:CanvasRuntime):URL|null {
  if(!reg.canvas_api_origin)return null;
  if(!validId(course)||!validId(user))throw new Error('Canvas course or user identifier is not safe for API lookup');
  const origin=new URL(reg.canvas_api_origin);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')
    throw new Error('Canvas API origin must be an origin');
  const local=new URL(env.PUBLIC_BASE_URL);
  const dev=env.ENABLE_LOCAL_HTTP==='1'&&local.protocol==='http:'&&['localhost','127.0.0.1'].includes(local.hostname);
  if(origin.protocol!=='https:' && !(dev&&origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)))
    throw new Error('Canvas API requires HTTPS');
  const url=new URL('/api/v1/courses/'+encodeURIComponent(course)+'/enrollments',origin);
  url.searchParams.set('user_id',user);
  url.searchParams.append('type[]','StudentEnrollment');
  url.searchParams.set('per_page','100');
  return url;
}
export function canvasToken(reg:CanvasConfig,env:CanvasRuntime):string|null{
  if(!reg.canvas_api_origin)return null;
  if(!env.CANVAS_API_TOKENS)return null;
  let tokens:unknown;
  try{tokens=JSON.parse(env.CANVAS_API_TOKENS);}catch{throw new Error('Invalid Canvas API token configuration');}
  if(!tokens||typeof tokens!=='object'||Array.isArray(tokens))throw new Error('Invalid Canvas API token configuration');
  const value=(tokens as Record<string,unknown>)[reg.id];
  return typeof value==='string'&&value.length>=12?value:null;
}
export async function lookupCanvasSections(reg:CanvasConfig,course:string,user:string,env:CanvasRuntime):Promise<string[]|null>{
  const endpoint=canvasEndpoint(reg,course,user,env),token=canvasToken(reg,env);
  if(!endpoint||!token)return null;
  const sections=new Set<string>();
  let next:URL|null=endpoint;
  const visited=new Set<string>();
  for(let page=0;next&&page<10;page++){
    if(visited.has(next.toString()))throw new Error('Canvas API pagination cycle');
    visited.add(next.toString());
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),4500);
    let res:Response;
    try{
      res=await fetch(next,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'manual',signal:controller.signal});
    }finally{clearTimeout(timer);}
    if(!res.ok)throw new Error('Canvas API lookup unavailable ('+res.status+')');
    const raw=await res.text();
    if(raw.length>300000)throw new Error('Canvas API response exceeds size limit');
    let rows:unknown;
    try{rows=JSON.parse(raw);}catch{throw new Error('Invalid Canvas API response');}
    if(!Array.isArray(rows))throw new Error('Canvas API enrollment response must be an array');
    for(const record of rows){
      if(!record||typeof record!=='object')continue;
      const item=record as Record<string,unknown>;
      if(String(item.user_id)!==user||String(item.course_id)!==course)continue;
      if(!['active','invited'].includes(String(item.enrollment_state)))continue;
      const id=String(item.course_section_id??'');
      if(validId(id))sections.add(id);
      if(sections.size>100)throw new Error('Canvas API returned too many sections');
    }
    const link=res.headers.get('Link')||'';
    const match=link.match(/<([^>]+)>;\s*rel="next"/);
    if(!match){next=null;break;}
    const candidate=new URL(match[1],next);
    if(candidate.origin!==endpoint.origin||candidate.pathname!==endpoint.pathname)
      throw new Error('Canvas pagination crossed a registered API boundary');
    next=candidate;
    if(page===9)throw new Error('Canvas API pagination exceeds limit');
  }
  return [...sections].sort();
}
