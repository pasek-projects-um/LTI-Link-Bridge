// Local Canvas-like LTI 1.3 simulator. Test keys only; never deploy this server.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { SignJWT, importJWK, jwtVerify, createRemoteJWKSet } from 'jose';

const keys = JSON.parse(readFileSync('.simulator/keys.json', 'utf8'));
const port = Number(process.env.SIM_PORT || 8788);
const bridge = process.env.BRIDGE_URL || 'http://localhost:8787';
const issuer = 'http://localhost:' + port;
const client = 'bridge-simulator';
const claim = 'https://purl.imsglobal.org/spec/lti/claim/';
const deepClaim = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
const instructorRole = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
const learnerRole = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
const placements = new Map();
const htmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body); };
const landing = (title, body) => '<!doctype html><html lang="en"><meta charset="utf-8"><title>' + htmlEscape(title) + '</title><style>body{font:16px system-ui;margin:3rem auto;max-width:960px;padding:0 1rem}a{color:#2158a5}li{margin:.6rem 0}</style><h1>' + htmlEscape(title) + '</h1>' + body + '</html>';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = text => JSON.parse(Buffer.from(text, 'base64url').toString());
async function parseBody(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 200000) throw new Error('Too large');
  }
  return new URLSearchParams(content);
}
function formPost(url, params) {
  const inputs = Object.entries(params).map(([name, value]) => '<input type="hidden" name="' + htmlEscape(name) + '" value="' + htmlEscape(value) + '">').join('');
  return landing('Completing Canvas LTI launch', '<p>Posting a signed LTI launch to the link bridge.</p><form id="lti-post" method="post" action="' + htmlEscape(url) + '">' + inputs + '<button>Continue</button></form><script>document.getElementById("lti-post").submit()</script>');
}
function hintFrom(url) {
  return {
    role: url.searchParams.get('role') || 'student',
    user: url.searchParams.get('user') || (url.searchParams.get('role') === 'instructor' ? 'teacher-1' : 'student-1'),
    course: url.searchParams.get('course') || 'course-a',
    link: url.searchParams.get('link') || 'sim-activity-a',
    kind: url.searchParams.get('kind') || 'resource',
    bad: url.searchParams.get('bad') || '',
    missing: url.searchParams.get('missing') || '',
    deployment: url.searchParams.get('deployment') || 'sim-deployment'
  };
}
async function makeToken(query) {
  const hint = decode(query.get('login_hint'));
  const bad = hint.bad;
  const deep = hint.kind === 'deep';
  const now = Math.floor(Date.now() / 1000);
  const custom = deep || hint.kind === 'dashboard' || hint.missing === 'custom' ? undefined : { bridge_link_id: hint.link };
  const claims = {
    nonce: query.get('nonce'),
    [claim + 'version']: '1.3.0',
    [claim + 'message_type']: deep ? 'LtiDeepLinkingRequest' : 'LtiResourceLinkRequest',
    [claim + 'deployment_id']: bad === 'deployment' ? 'unknown-deployment' : hint.deployment,
    [claim + 'context']: { id: hint.course, title: 'Simulated ' + hint.course },
    [claim + 'resource_link']: { id: deep ? 'instructor-deep-link' : hint.kind === 'dashboard' ? 'instructor-dashboard' : 'resource:' + hint.course + ':' + hint.link },
    [claim + 'roles']: [hint.role === 'instructor' ? instructorRole : learnerRole],
    ...(custom ? { [claim + 'custom']: custom } : {}),
    ...(deep ? { [deepClaim + 'deep_linking_settings']: { deep_link_return_url: hint.bad === 'return' ? 'https://attacker.invalid/steal' : issuer + '/return', data: encode({ course: hint.course, user: hint.user }), accept_types: ['ltiResourceLink'], accept_presentation_document_targets: ['iframe', 'window'] } } : {})
  };
  if (hint.missing !== 'identity') { claims.name = hint.user + ' (Simulated)'; claims.email = hint.user + '@example.invalid'; }
  const key = await importJWK(bad === 'signature' ? keys.alternate.privateJwk : keys.platform.privateJwk, 'RS256');
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'simulator-test-v1' })
    .setIssuer(bad === 'issuer' ? 'https://invalid-issuer.invalid' : issuer)
    .setSubject(hint.user)
    .setAudience(bad === 'audience' ? 'wrong-client' : client)
    .setIssuedAt(bad === 'expired' ? now - 1800 : now)
    .setExpirationTime(bad === 'expired' ? now - 1200 : now + 300);
  return jwt.sign(key);
}
const app = createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  try {
    if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    if (url.pathname === '/jwks') return send(res, 200, JSON.stringify({ keys: [keys.platform.publicJwk] }), { 'Content-Type': 'application/json' });
    if (url.pathname === '/start') {
      const hint = hintFrom(url);
      const target = new URL('/lti/login', bridge);
      target.searchParams.set('iss', issuer);
      target.searchParams.set('client_id', client);
      target.searchParams.set('target_link_uri', bridge + '/lti/launch');
      target.searchParams.set('login_hint', encode(hint));
      target.searchParams.set('lti_message_hint', 'simulator-message');
      return send(res, 302, '', { Location: target.toString() });
    }
    if (url.pathname === '/authorize') {
      if (!url.searchParams.get('nonce') || !url.searchParams.get('state') || !url.searchParams.get('login_hint')) return send(res, 400, 'Missing OIDC request parameters');
      const token = await makeToken(url.searchParams);
      return send(res, 200, formPost(url.searchParams.get('redirect_uri'), { id_token: token, state: url.searchParams.get('state') }));
    }
    if (url.pathname === '/return' && req.method === 'POST') {
      const post = await parseBody(req);
      const token = post.get('JWT');
      if (!token) return send(res, 400, 'Missing Deep Linking JWT');
      const set = createRemoteJWKSet(new URL('/lti/jwks', bridge));
      const verified = await jwtVerify(token, set, { issuer: client, audience: issuer, algorithms: ['RS256'] });
      const items = verified.payload[deepClaim + 'content_items'];
      const original = decode(verified.payload[deepClaim + 'data']);
      if (!Array.isArray(items) || items.some(x => x.type !== 'ltiResourceLink' || !x.custom?.bridge_link_id)) return send(res, 400, 'Invalid content items');
      const list = placements.get(original.course) || [];
      for (const item of items) list.push({ title: item.title, link: item.custom.bridge_link_id, course: original.course });
      placements.set(original.course, list);
      return send(res, 200, landing('Link inserted into simulated Canvas', '<p>Deep Linking response verified and activity saved in simulated course ' + htmlEscape(original.course) + '.</p><a href="/">Simulator home</a>'));
    }
    if (url.pathname === '/links') return send(res, 200, JSON.stringify(Object.fromEntries(placements)), { 'Content-Type': 'application/json' });
    if (url.pathname === '/activity') {
      const params = Object.fromEntries(url.searchParams);
      return send(res, 200, landing('External activity opened', '<p>Destination arrived. Pseudonymous URL parameters:</p><pre>' + htmlEscape(JSON.stringify(params, null, 2)) + '</pre>'));
    }
    if (url.pathname === '/') {
      const sample = [
        ['Instructor dashboard', '/start?role=instructor&kind=dashboard'],
        ['Instructor Deep Linking', '/start?role=instructor&kind=deep'],
        ['Student 1 · Activity A', '/start?role=student&user=student-1&link=sim-activity-a'],
        ['Student 2 · Activity A', '/start?role=student&user=student-2&link=sim-activity-a'],
        ['Student 1 · Activity B', '/start?role=student&user=student-1&link=sim-activity-b'],
        ['Student 1 · Course B', '/start?role=student&user=student-1&course=course-b&link=sim-activity-c']
      ];
      for (const [course, links] of placements) for (const item of links) sample.push([course + ' · ' + item.title, '/start?role=student&user=student-1&course=' + encodeURIComponent(course) + '&link=' + encodeURIComponent(item.link)]);
      return send(res, 200, landing('Canvas simulator (test keys only)', '<p>Launches use real OIDC initiation and RS256 LTI tokens. All users, courses, and activity destinations are simulated.</p><ul>' + sample.map(([title, href]) => '<li><a href="' + htmlEscape(href) + '">' + htmlEscape(title) + '</a></li>').join('') + '</ul>'));
    }
    return send(res, 404, 'Unknown simulator route');
  } catch (err) {
    console.error('Simulator error:', err.message);
    return send(res, 500, 'Simulation error: ' + htmlEscape(err.message));
  }
});
app.listen(port, () => console.log('Simulated Canvas platform at ' + issuer));
