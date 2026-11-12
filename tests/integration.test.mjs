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
