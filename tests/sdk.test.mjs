import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readBridgeContext,createBridgeTracker} from '../browser/bridge-client.mjs';

const user='U_'+'a'.repeat(27),course='C_'+'b'.repeat(27),section='S_'+'c'.repeat(27);
const launch='9e8ee45a-3557-48ba-8dc3-27a45805f674';
test('reads only validated pseudonymous parameters',()=>{
  const ctx=readBridgeContext('https://activity.example/?user='+user+'&course='+course+'&section='+section+'&launch='+launch+'&email=student@example.edu');
  assert.deepEqual(ctx,{user,course,section,link:null,launch});
  assert.ok(!JSON.stringify(ctx).includes('example.edu'));
  assert.equal(Object.isFrozen(ctx),true);
});
test('custom parameter names are supported by a destination',()=>{
  const ctx=readBridgeContext('https://activity.example/?student_code='+user+'&visit='+launch,{user:'student_code',launch:'visit'});
  assert.equal(ctx.user,user);assert.equal(ctx.launch,launch);
});
test('tracker generates distinct event identifiers, elapsed time and same-origin POSTs',async()=>{
  const sent=[];let clock=100;
  const tracker=createBridgeTracker({
    context:{user,course,section:null,link:null,launch},
    pageUrl:'https://activity.example/activity',
    endpoint:'/api/events',performanceNow:()=>clock,
    now:()=> '2026-11-12T00:00:00.000Z',
    fetchImpl:async (url,opts)=>{sent.push({url,opts});return {ok:true};}
  });
  clock=250;
  const start=await tracker.activityStarted({progress:1});
  clock=775;
  const finish=await tracker.activityFinished({progress:100});
  assert.equal(start.elapsed_ms,150);assert.equal(finish.elapsed_ms,675);
  assert.notEqual(start.event_id,finish.event_id);
  assert.equal(sent[0].url,'https://activity.example/api/events');
  assert.equal(JSON.parse(sent[1].opts.body).bridge.user,user);
  assert.equal(sent[1].opts.credentials,'same-origin');
});
test('rejects cross-origin receivers and unsupported event types',async()=>{
  assert.throws(()=>createBridgeTracker({context:{launch},pageUrl:'https://activity.example/',endpoint:'https://evil.example/ingest'}),/same-origin/);
  const tracker=createBridgeTracker({context:{launch},pageUrl:'https://activity.example/',fetchImpl:async()=>({ok:true})});
  await assert.rejects(()=>tracker.emit('student_identified'),/Unsupported/);
});
