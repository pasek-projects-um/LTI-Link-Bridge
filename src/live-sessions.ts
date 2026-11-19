import { hmac, randomId, urlToken } from './crypto.ts';

/** A live cohort is separate from a Canvas assignment and an activity generation. */
export interface LiveSession {
  id: string;
  deployment_id: string;
  course_id: string;
  link_id: string;
  label: string;
  state: 'open'|'closed';
  allow_admitted_resume: number;
  created_at: string;
  closed_at: string|null;
}

/** The instructor sees the plaintext code only at creation/rotation. */
export interface NewLiveSession {
  session: LiveSession;
  code: string;
}

/** Codes are human-readable but sufficiently random to resist casual guessing. */
export function generateClassCode(): string {
  // 10 base32 characters: 50 random bits, grouped for classroom readability.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // Rejection sampling avoids modulo bias while retaining 50 random bits.
  const chars: string[]=[];
  while(chars.length<10){
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    for(const value of bytes){
      if(value>=Math.floor(256/alphabet.length)*alphabet.length)continue;
      chars.push(alphabet[value%alphabet.length]);
      if(chars.length===10)break;
    }
  }
  return chars.slice(0,5).join('')+'-'+chars.slice(5).join('');
}

export function normalizeClassCode(code: string): string {
  return code.trim().toUpperCase().replace(/[-\s]/g,'');
}

export function validClassCode(code: string): boolean {
  return /^[A-HJ-NP-Z2-9]{10}$/.test(normalizeClassCode(code));
}

async function digestCode(secret: string, salt: string, code: string): Promise<string> {
  // Keyed hashing prevents offline brute-force attacks on the short classroom code.
  return hmac(secret,'live-class-code',salt,normalizeClassCode(code));
}

export async function createLiveSession(
  db: D1Database, secret: string, fields: {
    deployment: string; course: string; link: string; label: string;
    instructor: string; code?: string;
  }
): Promise<NewLiveSession> {
  const code=fields.code?.trim() || generateClassCode();
  if(!validClassCode(code))throw new Error('Class codes need 10 unambiguous letters or digits (2-9)');
  const existing=await db.prepare(
    "SELECT id FROM live_sessions WHERE deployment_id=? AND course_id=? AND link_id=? AND state='open'"
  ).bind(fields.deployment,fields.course,fields.link).first();
  if(existing)throw new Error('Close the current class session before starting another');
  const id=randomId(),salt=urlToken(16),now=new Date().toISOString();
  await db.prepare(`INSERT INTO live_sessions
    (id,deployment_id,course_id,link_id,label,code_hash,code_salt,
     created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(id,fields.deployment,fields.course,fields.link,fields.label,
      await digestCode(secret,salt,code),salt,fields.instructor,now).run();
  const session=await db.prepare('SELECT * FROM live_sessions WHERE id=?')
    .bind(id).first<LiveSession>();
  if(!session)throw new Error('Created live session not found');
  return {session,code};
}

export async function getLatestLiveSession(
  db:D1Database,deployment:string,course:string,link:string
):Promise<LiveSession|null>{
  return db.prepare(`SELECT id,deployment_id,course_id,link_id,label,state,
    allow_admitted_resume,created_at,closed_at FROM live_sessions
    WHERE deployment_id=? AND course_id=? AND link_id=?
    ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(deployment,course,link).first<LiveSession>();
}

export async function getOpenLiveSession(
  db:D1Database,deployment:string,course:string,link:string
):Promise<LiveSession|null>{
  return db.prepare(`SELECT id,deployment_id,course_id,link_id,label,state,
    allow_admitted_resume,created_at,closed_at FROM live_sessions
    WHERE deployment_id=? AND course_id=? AND link_id=? AND state='open' LIMIT 1`)
    .bind(deployment,course,link).first<LiveSession>();
}

export async function admittedToSession(
  db:D1Database,sessionId:string,canvasUserId:string
):Promise<boolean>{
  return !!await db.prepare(
    'SELECT 1 FROM live_admissions WHERE session_id=? AND user_id=?'
  ).bind(sessionId,canvasUserId).first();
}

export interface LiveAdmissionResult {
  status: 'accepted'|'incorrect'|'rate_limited'|'closed';
  sessionId?: string;
}

/**
 * Verify an admission code only for the active instructor session.
 * An already admitted student is not prompted again for that session.
 * The student's verified Canvas user ID, not a query string, owns admission.
 */
export async function admitStudent(
  db:D1Database,secret:string,fields:{
    sessionId:string;deployment:string;course:string;link:string;
    canvasUserId:string;userCode:string;code:string;
  }
):Promise<LiveAdmissionResult>{
  const session=await db.prepare(`SELECT id,state,code_salt,code_hash
    FROM live_sessions WHERE id=? AND deployment_id=? AND course_id=? AND link_id=?`)
    .bind(fields.sessionId,fields.deployment,fields.course,fields.link)
    .first<{id:string;state:'open'|'closed';code_salt:string;code_hash:string}>();
  if(!session || session.state!=='open')return {status:'closed'};
  const admitted=await admittedToSession(db,session.id,fields.canvasUserId);
  if(admitted)return {status:'accepted',sessionId:session.id};

  const time=new Date(),since=new Date(time.getTime()-15*60_000).toISOString();
  const attempts=await db.prepare(`SELECT COUNT(*) AS total FROM live_code_attempts
    WHERE session_id=? AND user_code=? AND attempted_at>=? AND result!='accepted'`)
    .bind(session.id,fields.userCode,since).first<{total:number}>();
  if((attempts?.total||0)>=5){
    await db.prepare('INSERT INTO live_code_attempts(id,session_id,user_code,attempted_at,result) VALUES(?,?,?,?,?)')
      .bind(randomId(),time.toISOString(),fields.userCode,time.toISOString(),'rate_limited').run();
    return {status:'rate_limited'};
  }

  const valid=validClassCode(fields.code) &&
    await digestCode(secret,session.code_salt,fields.code)===session.code_hash;
  const result=valid?'accepted':'incorrect';
  const attemptId=randomId(),at=time.toISOString();
  await db.batch([
    db.prepare('INSERT INTO live_code_attempts(id,session_id,user_code,attempted_at,result) VALUES(?,?,?,?,?)')
      .bind(attemptId,session.id,fields.userCode,at,result),
    db.prepare(`INSERT OR IGNORE INTO live_admissions(session_id,user_id,admitted_at)
      SELECT ?,?,? WHERE EXISTS (
        SELECT 1 FROM live_sessions WHERE id=? AND state='open'
      ) AND ?='accepted'`)
      .bind(session.id,fields.canvasUserId,at,session.id,result)
  ]);
  if(!valid)return {status:'incorrect'};
  return await admittedToSession(db,session.id,fields.canvasUserId)
    ? {status:'accepted',sessionId:session.id}
    : {status:'closed'};
}

/** Closing a cohort removes its ability to admit new students. */
export async function closeLiveSession(
  db:D1Database,sessionId:string,deployment:string,course:string,link:string,
  allowResume:boolean
):Promise<boolean>{
  const result=await db.prepare(`UPDATE live_sessions SET state='closed',
    allow_admitted_resume=?,closed_at=?
    WHERE id=? AND deployment_id=? AND course_id=? AND link_id=? AND state='open'`)
    .bind(allowResume?1:0,new Date().toISOString(),sessionId,deployment,course,link).run();
  return result.meta.changes===1;
}

/** Find an admitted cohort for resumptions, even after closure if allowed. */
export async function resumableSession(
  db:D1Database,deployment:string,course:string,link:string,canvasUserId:string
):Promise<LiveSession|null>{
  return db.prepare(`SELECT s.id,s.deployment_id,s.course_id,s.link_id,s.label,
    s.state,s.allow_admitted_resume,s.created_at,s.closed_at
    FROM live_sessions s JOIN live_admissions a ON a.session_id=s.id
    WHERE s.deployment_id=? AND s.course_id=? AND s.link_id=? AND a.user_id=?
      AND (s.state='open' OR s.allow_admitted_resume=1)
    ORDER BY s.created_at DESC,s.id DESC LIMIT 1`)
    .bind(deployment,course,link,canvasUserId).first<LiveSession>();
}
