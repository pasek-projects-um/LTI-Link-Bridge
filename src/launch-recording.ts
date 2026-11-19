import type { GenerationMode } from './generation-policy.ts';

/**
 * All values needed to record one verified Canvas launch.
 *
 * The caller must verify the LTI JWT, course, deployment, link binding and
 * destination before calling this function. The Canvas user ID is used only
 * for per-student limits and protected identity mappings.
 */
export interface VerifiedLaunchRecord {
  deploymentId: string;
  institution: string;
  courseId: string;
  canvasUserId: string;
  fullName: string | null;
  email: string | null;
  linkId: string;
  userScope: string;
  keyVersion: string;
  courseCode: string;
  userCode: string;
  sectionCode: string | null;
  resourceLinkId: string;
  destinationOrigin: string;
  tokenFingerprint: string;
  launchId: string;
  generationId: string;
  generationMode: GenerationMode;
  occurredAt: string;
}

export type LaunchRecordingResult =
  | { status: 'recorded'; generationId: string }
  | { status: 'already_used' }
  | { status: 'duplicate_launch' };

/**
 * Reserve the generation and record the launch in one D1 transaction.
 *
 * A stable generation belongs to one student and one Canvas placement. A fresh
 * generation belongs to just one launch. Every accepted visit has a distinct
 * launch row, regardless of whether its generation is reused.
 *
 * The last_launch_id reservation is a concurrency guard: two simultaneous
 * visits cannot both consume a once-per-student generation.
 */
export async function recordVerifiedLaunch(
  db: D1Database,
  launch: VerifiedLaunchRecord
): Promise<LaunchRecordingResult> {
  const {
    deploymentId, institution, courseId, canvasUserId, fullName, email,
    linkId, userScope, keyVersion, courseCode, userCode, sectionCode,
    resourceLinkId, destinationOrigin, tokenFingerprint, launchId,
    generationId, generationMode, occurredAt
  } = launch;

  const usesFreshGeneration = generationMode === 'new_each_time';
  const generationWhere = usesFreshGeneration
    ? 'generation_id=?'
    : "deployment_id=? AND course_id=? AND link_id=? AND resource_link_id=? AND user_id=? AND generation_id LIKE 'stable-%'";
  const generationBindings = usesFreshGeneration
    ? [generationId]
    : [deploymentId,courseId,linkId,resourceLinkId,canvasUserId];

  const statements = [
    db.prepare(`INSERT OR IGNORE INTO link_generations
      (generation_id,deployment_id,course_id,link_id,resource_link_id,user_id,created_at)
      VALUES(?,?,?,?,?,?,?)`)
      .bind(generationId,deploymentId,courseId,linkId,resourceLinkId,canvasUserId,occurredAt),

    db.prepare(`UPDATE link_generations
      SET use_count=use_count+1,last_launch_id=?
      WHERE ${generationWhere}
        AND (? != 'once_per_student' OR use_count=0)`)
      .bind(launchId,...generationBindings,generationMode),

    db.prepare(`INSERT OR IGNORE INTO launches
      (id,token_fingerprint,event_time,deployment_id,institution,course_id,
       course_code,user_code,section_code,link_id,destination_origin,
       resource_link_id,status,redirect_status,key_version,generation_id)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,generation_id
      FROM link_generations WHERE ${generationWhere} AND last_launch_id=?`)
      .bind(launchId,tokenFingerprint,occurredAt,deploymentId,institution,
        courseId,courseCode,userCode,sectionCode,linkId,destinationOrigin,
        resourceLinkId,'recorded','issued',keyVersion,...generationBindings,launchId),

    // Identity data are written only for successful launch records.
    db.prepare(`INSERT OR IGNORE INTO identities
      (deployment_id,course_id,user_id,full_name,email,first_seen,last_seen)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM launches WHERE id=?)`)
      .bind(deploymentId,courseId,canvasUserId,fullName,email,occurredAt,occurredAt,launchId),

    db.prepare(`UPDATE identities SET last_seen=?
      WHERE deployment_id=? AND course_id=? AND user_id=?
        AND EXISTS (SELECT 1 FROM launches WHERE id=?)`)
      .bind(occurredAt,deploymentId,courseId,canvasUserId,launchId),

    db.prepare(`INSERT OR IGNORE INTO identity_codes
      (deployment_id,course_id,user_id,user_code,scope,link_id,key_version)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM launches WHERE id=?)`)
      .bind(deploymentId,courseId,canvasUserId,userCode,userScope,
        userScope==='activity'?linkId:'',keyVersion,launchId),

    // Record EVERY authenticated request reaching this stage, including a
    // repeat that a once-per-student policy refuses. No second generation or
    // successful launch is created for a refused attempt.
    db.prepare(`INSERT INTO launch_attempts
      (attempt_id,attempted_at,deployment_id,course_id,link_id,resource_link_id,
       user_code,token_fingerprint,outcome,launch_id,generation_id)
      SELECT ?,?,?,?,?,?,?,?,
        CASE
          WHEN EXISTS(SELECT 1 FROM launches WHERE id=?) THEN 'launched'
          WHEN ?='once_per_student' THEN 'blocked_single_use'
          ELSE 'duplicate_token'
        END,
        CASE WHEN EXISTS(SELECT 1 FROM launches WHERE id=?) THEN ? ELSE NULL END,
        (SELECT generation_id FROM launches WHERE id=?)
      `)
      .bind(launchId,occurredAt,deploymentId,courseId,linkId,resourceLinkId,
        userCode,tokenFingerprint,launchId,generationMode,launchId,launchId,launchId)
  ];

  const results=await db.batch(statements);
  if(results[2].meta.changes!==1){
    return {status:generationMode==='once_per_student'?'already_used':'duplicate_launch'};
  }

  // A concurrent first visit might have won the stable-generation insert.
  // Return the actual ID recorded in the launch, not the proposed ID.
  const recorded=await db.prepare('SELECT generation_id FROM launches WHERE id=?')
    .bind(launchId).first<{generation_id:string}>();
  if(!recorded?.generation_id)throw new Error('Recorded generation could not be found');
  return {status:'recorded',generationId:recorded.generation_id};
}
