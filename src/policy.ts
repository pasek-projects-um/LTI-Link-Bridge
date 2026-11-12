export interface PlatformUrlRegistration { auth_url: string; deep_link_return_origins?: string | null; }
export interface UrlRuntime { PUBLIC_BASE_URL: string; ENABLE_LOCAL_HTTP?: string; }
function loopback(url:URL):boolean {return url.hostname==='localhost' || url.hostname==='127.0.0.1' || url.hostname==='[::1]';}
export function isLocalDevelopment(env:UrlRuntime):boolean {
  try {const url=new URL(env.PUBLIC_BASE_URL);return env.ENABLE_LOCAL_HTTP==='1' && url.protocol==='http:' && loopback(url);}catch{return false;}
}
export function safeExternalUrl(raw:string,env:UrlRuntime):URL {
  const url=new URL(raw);
  if(url.username||url.password)throw new Error('Embedded URL credentials not permitted');
  if(url.protocol!=='https:' && !(isLocalDevelopment(env)&&url.protocol==='http:'&&loopback(url)))
    throw new Error('External URLs must be HTTPS (except local simulator)');
  if(!isLocalDevelopment(env)&&loopback(url))throw new Error('Loopback URL not permitted outside local simulator');
  return url;
}
export function validatedDeepLinkReturn(raw:string,reg:PlatformUrlRegistration,env:UrlRuntime):URL {
  const dest=safeExternalUrl(raw,env);
  if(dest.hash)throw new Error('Deep Linking return URL fragments not allowed');
  const configured=reg.deep_link_return_origins?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  const origins=[new URL(reg.auth_url).origin,...configured.map(value=>{
    const candidate=safeExternalUrl(value,env);
    if(candidate.pathname!=='/'||candidate.search||candidate.hash)throw new Error('Return origin must be an origin, without path');
    return candidate.origin;
  })];
  if(!origins.includes(dest.origin))throw new Error('Deep Linking return origin not registered');
  return dest;
}
