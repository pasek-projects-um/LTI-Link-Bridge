// Optional destination-side helper. Does not authenticate the user.
// Host applications MUST authorize their own API requests independently.
const VALID_CODE=/^[UCS]_[A-Za-z0-9_-]{16,}$/;
const VALID_LINK=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^sim-[a-z0-9-]+$/i;
const EVENTS=new Set(['page_opened','activity_started','submission_completed','activity_finished']);
function param(search,name,validator) {
  const value=search.get(name);
  return value && validator.test(value) ? value : null;
}
export function readBridgeContext(input, names={}) {
  const href=input ?? (typeof location!=='undefined'?location.href:'');
  if(!href)throw new Error('URL required outside a browser');
  const url=new URL(href);
  const search=url.searchParams;
  const name=key=>names[key]||key;
  const user=param(search,name('user'),VALID_CODE);
  const course=param(search,name('course'),VALID_CODE);
  const section=param(search,name('section'),VALID_CODE);
  const link=param(search,name('link'),VALID_LINK);
  const launch=param(search,name('launch'),VALID_LINK);
  const clean=(kind,value)=>value?.startsWith(kind+'_')?value:null;
  return Object.freeze({user:clean('U',user),course:clean('C',course),section:clean('S',section),link,launch});
}
function safeEventName(event) {
  if(!EVENTS.has(event))throw new Error('Unsupported activity event');
  return event;
}
export function createBridgeTracker({
  context, endpoint='/api/activity-events', pageUrl,
  fetchImpl=globalThis.fetch, now=()=>new Date().toISOString(),
  performanceNow=()=>globalThis.performance?.now() ?? Date.now(),
  eventMetadata={}
}={}) {
  const ids=context??readBridgeContext(pageUrl);
  if(!ids.launch)throw new Error('Missing valid launch ID; event correlation unavailable');
  const base=pageUrl??(typeof location!=='undefined'?location.href:'http://localhost');
  const receiver=new URL(endpoint,base);
  if(receiver.origin!==new URL(base).origin)throw new Error('Activity events must go to a same-origin receiver');
  const startedAt=performanceNow();
  async function emit(name, metadata={}) {
    safeEventName(name);
    const elapsedMs=Math.max(0,Math.round(performanceNow()-startedAt));
    const payload={
      event_id:globalThis.crypto.randomUUID(),
      event_type:name,
      event_time:now(),
      elapsed_ms:elapsedMs,
      bridge:ids,
      metadata:{...eventMetadata,...metadata}
    };
    const result=await fetchImpl(receiver.toString(),{
      method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    if(!result.ok)throw new Error('Activity receiver returned HTTP '+result.status);
    return payload;
  }
  return Object.freeze({
    context:ids,
    pageOpened:(metadata)=>emit('page_opened',metadata),
    activityStarted:(metadata)=>emit('activity_started',metadata),
    submissionCompleted:(metadata)=>emit('submission_completed',metadata),
    activityFinished:(metadata)=>emit('activity_finished',metadata),
    emit
  });
}
// The receiving website must verify and authorize events itself.
// URL pseudonyms and launch UUIDs are correlation values, NOT credentials.
