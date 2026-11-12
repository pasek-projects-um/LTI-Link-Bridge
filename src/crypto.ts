import { createRemoteJWKSet, jwtVerify, SignJWT, importJWK, type JWTPayload, type JWK } from 'jose';

export const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
export const INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
export const ADMIN = 'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator';
const encoder = new TextEncoder();
export function randomId(): string { return crypto.randomUUID(); }
export function urlToken(bytes = 24): string { const a = crypto.getRandomValues(new Uint8Array(bytes)); return b64url(a); }
export function b64url(bytes: Uint8Array): string {
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decodeSecret(value: string): Uint8Array {
  const normalized = value.replace(/-/g,'+').replace(/_/g,'/');
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));
  const result = Uint8Array.from(decoded, c=>c.charCodeAt(0));
  if (result.length < 32) throw new Error('Secret must contain >= 32 random bytes');
  return result;
}
export async function hmac(secret: string, ...parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey('raw',decodeSecret(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  // Canonical JSON serialization ensures different input sequences cannot alias.
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(JSON.stringify(parts))));
  return b64url(bytes.slice(0,20)); // 160 bits
}
export async function pseudonym(secret: string, kind: 'U'|'C'|'S', version: string, ...parts: string[]): Promise<string> {
  return kind + '_' + await hmac(secret,'lti-link-bridge',version,kind,...parts);
}
export async function fingerprint(token: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(token))));
}
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function platformKeys(url: string) {
  const parsed = new URL(url);
  if (!['https:','http:'].includes(parsed.protocol)) throw new Error('Invalid JWKS URL');
  let value = keys.get(url);
  if (!value) { value = createRemoteJWKSet(parsed, { cooldownDuration: 30000, cacheMaxAge: 300000 }); keys.set(url,value); }
  return value;
}
export async function verifyPlatformJwt(token: string, registration: {issuer:string;client_id:string;jwks_url:string}, nonce: string) {
  const { payload, protectedHeader } = await jwtVerify(token,platformKeys(registration.jwks_url),{
    issuer:registration.issuer,audience:registration.client_id,algorithms:['RS256'],clockTolerance:60,
    requiredClaims:['iat','exp','nonce','sub','iss','aud']
  });
  if (protectedHeader.alg !== 'RS256') throw new Error('Unsupported signature algorithm');
  if (payload.nonce !== nonce) throw new Error('Nonce mismatch');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== registration.client_id) throw new Error('Invalid azp');
  if (payload.azp && payload.azp !== registration.client_id) throw new Error('Invalid azp');
  if (typeof payload.iat !== 'number' || Math.abs(Date.now()/1000 - payload.iat) > 600) throw new Error('Invalid issued-at');
  return payload;
}
export async function signDeepLink(privateJwk: string, clientId: string, platformIssuer: string, claims: Record<string,unknown>) {
  const keyData = JSON.parse(privateJwk) as JWK;
  const privateKey = await importJWK(keyData,'RS256');
  return new SignJWT(claims as JWTPayload).setProtectedHeader({alg:'RS256',typ:'JWT',kid:keyData.kid || 'bridge-v1'})
    .setIssuer(clientId).setSubject(clientId).setAudience(platformIssuer)
    .setIssuedAt().setExpirationTime('5m').setJti(randomId()).sign(privateKey);
}
export function publicJwk(privateJwk: string): JWK {
  const key = JSON.parse(privateJwk) as JWK;
  return {kty:key.kty,n:key.n,e:key.e,kid:key.kid || 'bridge-v1',alg:'RS256',use:'sig'};
}
