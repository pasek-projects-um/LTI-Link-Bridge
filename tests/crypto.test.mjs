import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??= webcrypto;
// JS translation of core deterministic HMAC algorithm for no-install smoke testing.
const encode=(v)=>Buffer.from(v).toString('base64url');
async function pseudonym(secret,kind,version,...parts){const key=await crypto.subtle.importKey('raw',Buffer.from(secret,'base64url'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const result=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['lti-link-bridge',version,kind,...parts])));return kind+'_'+encode(Buffer.from(result).subarray(0,20));}
const secret=Buffer.alloc(32,17).toString('base64url');
test('same scope deterministic',async()=>assert.equal(await pseudonym(secret,'U','v1','school','deployment','courseA','student'),await pseudonym(secret,'U','v1','school','deployment','courseA','student')));
test('course and student domain separation',async()=>{assert.notEqual(await pseudonym(secret,'U','v1','school','deployment','courseA','student'),await pseudonym(secret,'U','v1','school','deployment','courseB','student'));assert.notEqual(await pseudonym(secret,'U','v1','student'),await pseudonym(secret,'C','v1','student'));});
test('secret version changes code',async()=>assert.notEqual(await pseudonym(secret,'U','v1','student'),await pseudonym(secret,'U','v2','student')));
