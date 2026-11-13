import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectDeployment} from '../scripts/preflight.mjs';
const config={name:'bridge-test',main:'src/index.ts',vars:{PUBLIC_BASE_URL:'https://bridge.test.example.edu'},d1_databases:[{binding:'DB',database_id:'9c264ae3-f7f1-49cd-86dd-f4ab78a839f2'}]};
const registration={institution:'test-institution',issuer:'https://canvas.test.example.edu',client_id:'123',deployment_id:'456',auth_url:'https://canvas.test.example.edu/api/lti/authorize_redirect',jwks_url:'https://canvas.test.example.edu/api/lti/security/jwks',canvas_api_origin:'https://canvas.test.example.edu',login_url:'https://bridge.test.example.edu/lti/login',launch_url:'https://bridge.test.example.edu/lti/launch',jwks_tool_url:'https://bridge.test.example.edu/lti/jwks'};
test('production preflight accepts non-secret HTTPS registration',()=>assert.deepEqual(inspectDeployment(config,registration),[]));
test('production preflight rejects simulator defaults and embedded secrets',()=>{
  const bad={...config,vars:{PUBLIC_BASE_URL:'http://localhost:8787',ENABLE_LOCAL_HTTP:'1',SESSION_SECRET:'accidental-secret'},d1_databases:[{binding:'DB',database_id:'00000000-0000-4000-8000-000000000001'}]};
  const issues=inspectDeployment(bad,registration).join(' ');
  for(const fragment of ['HTTPS','loopback','placeholder','SESSION_SECRET','ENABLE_LOCAL_HTTP'])assert.match(issues,new RegExp(fragment));
});
test('production preflight rejects untrusted Canvas API origin and mismatched tool URLs',()=>{
  const bad={...registration,canvas_api_origin:'http://localhost:8788',launch_url:'https://elsewhere.invalid/lti/launch'};
  const issues=inspectDeployment(config,bad).join(' ');
  assert.match(issues,/canvas_api_origin must use HTTPS/);
  assert.match(issues,/launch_url does not match/);
});
test('production preflight requires registration identifiers',()=>{
  const issues=inspectDeployment(config,{...registration,client_id:'',deployment_id:''}).join(' ');
  assert.match(issues,/missing client_id/);
  assert.match(issues,/missing deployment_id/);
});
