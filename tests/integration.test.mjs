import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const sim = 'http://localhost:8788';
const bridge = 'http://localhost:8787';
function decodeHtml(text) { return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function hidden(html, key) {
  const match = html.match(new RegExp('<input[^>]*name="' + key + '"[^>]*value="([^"]*)"'));
  if (!match) throw new Error('Missing hidden input ' + key);
  return decodeHtml(match[1]);
}
async function launch(query, opts = {}) {
  const first = await fetch(sim + '/start?' + new URLSearchParams(query), { redirect: 'manual' });
  assert.equal(first.status, 302);
  const second = await fetch(first.headers.get('location'), { redirect: 'manual' });
  assert.equal(second.status, 302);
  const authorize = await fetch(second.headers.get('location'));
  assert.equal(authorize.status, 200);
  const html = await authorize.text();
  const token = hidden(html, 'id_token');
  const state = opts.stateOverride || hidden(html, 'state');
  const post = await fetch(bridge + '/lti/launch', { method: 'POST', body: new URLSearchParams({ state, id_token: token }), redirect: 'manual' });
  if (post.status !== 303 && !query.bad && query.kind !== 'dashboard' && query.kind !== 'deep') console.error('LAUNCH RESPONSE', post.status, (await post.clone().text()).slice(0,500));
  if (post.status !== 200 && !query.bad && (query.kind === 'dashboard' || query.kind === 'deep')) console.error('INSTRUCTOR RESPONSE', post.status, (await post.clone().text()).slice(0,500));
  return { post, token, state, html };
}
before(async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const [a, b] = await Promise.all([fetch(sim + '/health'), fetch(bridge + '/health')]);
      if (a.ok && b.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Simulator and Worker not running');
});
test('every distinct launch redirects and receives its own recorded UUID', async () => {
  const a = await launch({ role: 'student', user: 'student-1', link: 'sim-activity-a' });
  const b = await launch({ role: 'student', user: 'student-1', link: 'sim-activity-a' });
  assert.equal(a.post.status, 303);
  assert.equal(b.post.status, 303);
  const ua = new URL(a.post.headers.get('location')), ub = new URL(b.post.headers.get('location'));
  assert.equal(ua.searchParams.get('keep'), 'yes');
  assert.equal(ua.hash, '#test');
  assert.match(ua.searchParams.get('user'), /^U_[A-Za-z0-9_-]+$/);
  assert.match(ua.searchParams.get('course'), /^C_[A-Za-z0-9_-]+$/);
  assert.match(ua.searchParams.get('section'), /^S_[A-Za-z0-9_-]+$/);
  assert.equal(ua.searchParams.get('user'), ub.searchParams.get('user'));
  assert.notEqual(ua.searchParams.get('launch'), ub.searchParams.get('launch'));
  assert.equal(ua.searchParams.get('course'), ub.searchParams.get('course'));
  assert.ok(!ua.search.includes('student-1'));
});
test('course and activity scopes differ and missing identity is allowed', async () => {
  const a = await launch({ user: 'student-1', link: 'sim-activity-a', missing: 'identity' });
  const b = await launch({ user: 'student-1', link: 'sim-activity-b' });
  const c = await launch({ user: 'student-1', link: 'sim-activity-c', course: 'course-b' });
  for (const result of [a,b,c]) assert.equal(result.post.status,303);
  const codes=[a,b,c].map(x=>new URL(x.post.headers.get('location')).searchParams.get('user'));
  assert.equal(new Set(codes).size,3);
});
test('invalid signature, issuer, audience, deployment and expiry are rejected', async t => {
  for (const bad of ['signature','issuer','audience','deployment','expired']) {
    await t.test(bad, async () => {
      const {post} = await launch({ bad });
      assert.equal(post.status,403);
      assert.equal(post.headers.get('location'),null);
    });
  }
});
test('same OIDC token/state cannot be replayed', async () => {
  const r=await launch({ user:'student-2' });
  assert.equal(r.post.status,303);
  const repeat=await fetch(bridge+'/lti/launch',{method:'POST',body:new URLSearchParams({state:r.state,id_token:r.token}),redirect:'manual'});
  assert.equal(repeat.status,403);
});
test('verified instructor sees history but student cannot retrieve protected CSV', async () => {
  const teacher=await launch({role:'instructor',kind:'dashboard',user:'teacher-1'});
  assert.equal(teacher.post.status,200);
  const cookie=teacher.post.headers.get('set-cookie').split(';')[0];
  const dashboard=await fetch(bridge+'/instructor?course=course-a&deployment=sim-1',{headers:{Cookie:cookie}});
  assert.equal(dashboard.status,200);
  const body=await dashboard.text();
  assert.match(body,/Course dashboard/);
  assert.match(body,/Simulation Activity A/);
  assert.match(body,/Launches by day/);
  assert.match(body,/Activity summary/);
  assert.match(body,/Student summary/);
  const exports=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=launches',{headers:{Cookie:cookie}});
  assert.equal(exports.status,200);
  const csv=await exports.text();
  assert.match(csv,/event_time/);
  assert.ok(csv.split('\r\n').length>3);
  const mapping=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=identities',{headers:{Cookie:cookie}});
  assert.equal(mapping.status,200);
  assert.match(await mapping.text(),/student-1/);
  const wrongCourse=await fetch(bridge+'/instructor?course=course-b&deployment=sim-1',{headers:{Cookie:cookie}});
  assert.equal(wrongCourse.status,403);
  const unauth=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=identities');
  assert.equal(unauth.status,403);
});
test('Deep Linking creates a link returned as a signed Canvas content item', async () => {
  const initiated = await launch({ role:'instructor', kind:'deep', user:'teacher-1' });
  assert.equal(initiated.post.status,200);
  const cookie=initiated.post.headers.get('set-cookie').split(';')[0];
  const startHtml=await initiated.post.text();
  const match=startHtml.match(/href="([^"]+)"/);
  assert.ok(match,'Deep Linking builder link');
  const continued=await fetch(bridge+decodeHtml(match[1]),{redirect:'manual'});
  assert.equal(continued.status,303);
  const topLevelCookie=continued.headers.get('set-cookie').split(';')[0];
  assert.match(continued.headers.get('set-cookie'),/SameSite=Lax/);
  const builder=await fetch(new URL(continued.headers.get('location'),bridge),{headers:{Cookie:topLevelCookie}});
  assert.equal(builder.status,200);
  const replay=await fetch(bridge+decodeHtml(match[1]),{redirect:'manual'});
  assert.equal(replay.status,403);
  const builderHtml=await builder.text();
  const data={
    course:hidden(builderHtml,'course'), deployment:hidden(builderHtml,'deployment'),
    return:hidden(builderHtml,'return'), data:hidden(builderHtml,'data'),
    csrf:hidden(builderHtml,'csrf'),title:'Created by integration test',
    destination:sim+'/activity?preexisting=ok',
    scope:'course', user:'on',course_code:'on',link:'on',launch:'on'
  };
  const created=await fetch(bridge+'/instructor/create',{method:'POST',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams(data)});
  assert.equal(created.status,200);
  const formHtml=await created.text();
  const signed=hidden(formHtml,'JWT');
  const returned=await fetch(sim+'/return',{method:'POST',body:new URLSearchParams({JWT:signed})});
  assert.equal(returned.status,200);
  const items=await (await fetch(sim+'/links')).json();
  const createdLink=items['course-a'].at(-1).link;
  const student=await launch({user:'student-1',link:createdLink});
  assert.equal(student.post.status,303);
  const location=new URL(student.post.headers.get('location'));
  assert.equal(location.searchParams.get('preexisting'),'ok');
  assert.equal(location.searchParams.get('link'),createdLink);
});

test('instructor can manage multiple section memberships for observed students', async () => {
  const first=await launch({user:'student-99',link:'sim-activity-a'});
  assert.equal(first.post.status,303);
  assert.equal(new URL(first.post.headers.get('location')).searchParams.get('section'),null);
  const teacher=await launch({role:'instructor',kind:'dashboard',user:'teacher-1'});
  assert.equal(teacher.post.status,200);
  const cookie=teacher.post.headers.get('set-cookie').split(';')[0];
  const uri=bridge+'/instructor/sections?course=course-a&deployment=sim-1';
  const screen=await fetch(uri,{headers:{Cookie:cookie}});
  assert.equal(screen.status,200);
  const page=await screen.text();
  assert.match(page,/student-99/);
  const form={course:'course-a',deployment:'sim-1',csrf:hidden(page,'csrf'),user_id:'student-99',section_id:'section-99',action:'add'};
  const save=await fetch(bridge+'/instructor/sections',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams(form)});
  assert.equal(save.status,303);
  form.section_id='section-88';
  const extra=await fetch(bridge+'/instructor/sections',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams(form)});
  assert.equal(extra.status,303);
  const second=await launch({user:'student-99',link:'sim-activity-a'});
  assert.equal(second.post.status,303);
  assert.match(new URL(second.post.headers.get('location')).searchParams.get('section'),/^S_/);
  const roster=await (await fetch(uri,{headers:{Cookie:cookie}})).text();
  assert.match(roster,/section-88; section-99|section-99; section-88/);
  const student=await fetch(uri);
  assert.equal(student.status,403);
  const incorrect=await fetch(bridge+'/instructor/sections',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams({...form, user_id:'student-not-seen'})});
  assert.equal(incorrect.status,400);
  const exportData=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=identities',{headers:{Cookie:cookie}});
  assert.equal(exportData.status,200);
  assert.match(await exportData.text(),/section-88/);
});

test('known resource placement resolves even if the optional custom claim is absent', async () => {
  const seeded=await launch({user:'student-1',link:'sim-activity-a'});
  assert.equal(seeded.post.status,303);
  const fallback=await launch({user:'student-1',link:'sim-activity-a',missing:'custom'});
  assert.equal(fallback.post.status,303);
  const target=new URL(fallback.post.headers.get('location'));
  assert.equal(target.searchParams.get('link'),'sim-activity-a');
});

test('Deep Linking refuses platform-signed callback to an unregistered origin',async()=>{
  const attempt=await launch({role:'instructor',kind:'deep',user:'teacher-1',bad:'return'});
  assert.equal(attempt.post.status,403);
  assert.equal(attempt.post.headers.get('set-cookie'),null);
  assert.equal(attempt.post.headers.get('location'),null);
});
test('instructor cannot modify Deep Linking callback or signed data through builder URL',async()=>{
  const initiated=await launch({role:'instructor',kind:'deep',user:'teacher-1'});
  assert.equal(initiated.post.status,200);
  const cookie=initiated.post.headers.get('set-cookie').split(';')[0];
  const html=await initiated.post.text();
  const href=decodeHtml(html.match(/href="([^"]+)"/)[1]);
  const continueResult=await fetch(bridge+href,{redirect:'manual'});
  assert.equal(continueResult.status,303);
  const builderUrl=new URL(continueResult.headers.get('location'),bridge);
  builderUrl.searchParams.set('return','https://attacker.invalid/steal');
  const tampered=await fetch(builderUrl,{headers:{Cookie:cookie}});
  assert.equal(tampered.status,403);
});

test('optional destination-side arrivals require per-link credentials and resist replay',async()=>{
  const student=await launch({user:'student-arrival',link:'sim-activity-a'});
  assert.equal(student.post.status,303);
  const destination=new URL(student.post.headers.get('location'));
  const launchId=destination.searchParams.get('launch');
  const teacher=await launch({role:'instructor',kind:'dashboard',user:'teacher-1'});
  assert.equal(teacher.post.status,200);
  const cookie=teacher.post.headers.get('set-cookie').split(';')[0];
  const settingsUrl=bridge+'/instructor/arrival?course=course-a&deployment=sim-1';
  const settings=await fetch(settingsUrl,{headers:{Cookie:cookie}});
  assert.equal(settings.status,200);
  const settingsHtml=await settings.text();
  assert.match(settingsHtml,/Destination arrival callbacks/);
  assert.doesNotMatch(settingsHtml,/id="callback-token"/);
  const form={course:'course-a',deployment:'sim-1',csrf:hidden(settingsHtml,'csrf'),link_id:'sim-activity-a',action:'rotate'};
  const created=await fetch(bridge+'/instructor/arrival',{method:'POST',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams(form)});
  assert.equal(created.status,200);
  const credentialHtml=await created.text();
  const token=credentialHtml.match(/id="callback-token">([^<]+)/)?.[1];
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(!credentialHtml.includes('student-arrival'));
  const event={link:'sim-activity-a',launch:launchId,event:'opened',nonce:crypto.randomUUID(),observed_at:new Date().toISOString()};
  const send=(key,body)=>fetch(bridge+'/api/arrival',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send('a'.repeat(43),event)).status,401);
  const valid=await send(token,event);
  assert.equal(valid.status,201);
  assert.equal((await valid.json()).recorded,true);
  assert.equal((await send(token,event)).status,409);
  assert.equal((await send(token,{...event,link:'sim-activity-b',nonce:crypto.randomUUID()})).status,401);
  assert.equal((await send(token,{...event,launch:crypto.randomUUID(),nonce:crypto.randomUUID()})).status,403);
  assert.equal((await send(token,{...event,nonce:crypto.randomUUID(),observed_at:'2020-01-01T00:00:00Z'})).status,400);
  const dash=await fetch(bridge+'/instructor?course=course-a&deployment=sim-1',{headers:{Cookie:cookie}});
  assert.equal(dash.status,200);
  const dashHtml=await dash.text();
  assert.match(dashHtml,/reported arrivals/);
  assert.match(dashHtml,/Destination opened \(UTC\)/);
  const csv=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=launches',{headers:{Cookie:cookie}});
  assert.equal(csv.status,200);
  const text=await csv.text();
  assert.match(text,/destination_opened_at/);
  const line=text.split('\r\n').find(row=>row.includes(launchId));
  assert.ok(line);
  assert.ok(line.split(',').at(-1).replaceAll('"','').trim().startsWith('20'));
  const newKey=await fetch(bridge+'/instructor/arrival',{method:'POST',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams(form)});
  assert.equal(newKey.status,200);
  const replacement=(await newKey.text()).match(/id="callback-token">([^<]+)/)?.[1];
  assert.notEqual(replacement,token);
  assert.equal((await send(token,{...event,nonce:crypto.randomUUID()})).status,401);
  assert.equal((await send(replacement,{...event,event:'finished',nonce:crypto.randomUUID(),observed_at:new Date().toISOString()})).status,201);
  assert.equal((await fetch(settingsUrl)).status,403);
});

test('only exact recognized LTI instructor roles grant course dashboard access',async()=>{
  const spoof=await launch({role:'spoof',kind:'dashboard',user:'role-spoof'});
  assert.equal(spoof.post.status,403);
  const assistant=await launch({role:'ta',kind:'dashboard',user:'ta-1'});
  assert.equal(assistant.post.status,200);
  const cookie=assistant.post.headers.get('set-cookie').split(';')[0];
  const page=await fetch(bridge+'/instructor?course=course-a&deployment=sim-1',{headers:{Cookie:cookie}});
  assert.equal(page.status,200);
});
test('concurrent genuine student launches yield distinct durable events',async()=>{
  const launches=await Promise.all(Array.from({length:12},(_,i)=>launch({user:'concurrent-'+i,link:'sim-activity-a'})));
  for(const result of launches)assert.equal(result.post.status,303);
  const uuids=launches.map(x=>new URL(x.post.headers.get('location')).searchParams.get('launch'));
  assert.equal(new Set(uuids).size,12);
  const instructor=await launch({role:'instructor',kind:'dashboard',user:'teacher-1'});
  const cookie=instructor.post.headers.get('set-cookie').split(';')[0];
  const history=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=launches',{headers:{Cookie:cookie}});
  assert.equal(history.status,200);
  const csv=await history.text();
  for(const launchId of uuids)assert.ok(csv.includes(launchId),'Missing durable launch '+launchId);
});
test('new courses use the explicitly active HMAC version; existing courses stay pinned',async()=>{
  const teacher=await launch({role:'instructor',kind:'deep',user:'teacher-c',course:'course-c'});
  assert.equal(teacher.post.status,200);
  const landing=await teacher.post.text(),href=decodeHtml(landing.match(/href="([^"]+)"/)[1]);
  const resumed=await fetch(bridge+href,{redirect:'manual'});
  assert.equal(resumed.status,303);
  const cookie=resumed.headers.get('set-cookie').split(';')[0];
  const builder=await fetch(new URL(resumed.headers.get('location'),bridge),{headers:{Cookie:cookie}});
  assert.equal(builder.status,200);
  const page=await builder.text();
  const created=await fetch(bridge+'/instructor/create',{method:'POST',headers:{Cookie:cookie,Origin:bridge},body:new URLSearchParams({
    course:hidden(page,'course'),deployment:hidden(page,'deployment'),return:hidden(page,'return'),
    data:hidden(page,'data'),csrf:hidden(page,'csrf'),
    title:'V2 Test Activity',destination:sim+'/activity',scope:'course',
    user:'on',course_code:'on',link:'on',launch:'on'
  })});
  assert.equal(created.status,200);
  const jwt=hidden(await created.text(),'JWT');
  const finish=await fetch(sim+'/return',{method:'POST',body:new URLSearchParams({JWT:jwt})});
  assert.equal(finish.status,200);
  const placements=await (await fetch(sim+'/links')).json();
  const link=placements['course-c'].at(-1).link;
  const student=await launch({role:'student',course:'course-c',user:'student-1',link});
  assert.equal(student.post.status,303);
  const mapping=await fetch(bridge+'/instructor/export?course=course-c&deployment=sim-1&type=identities',{headers:{Cookie:cookie}});
  assert.equal(mapping.status,200);
  const mappingCsv=await mapping.text();
  assert.ok(mappingCsv.includes('"v2"'),'New course should use active v2');
  const oldInstructor=await launch({role:'instructor',kind:'dashboard',user:'teacher-1',course:'course-a'});
  const oldCookie=oldInstructor.post.headers.get('set-cookie').split(';')[0];
  const oldMapping=await fetch(bridge+'/instructor/export?course=course-a&deployment=sim-1&type=identities',{headers:{Cookie:oldCookie}});
  assert.equal(oldMapping.status,200);
  assert.ok((await oldMapping.text()).includes('"v1"'),'Preexisting links must remain on v1');
});
