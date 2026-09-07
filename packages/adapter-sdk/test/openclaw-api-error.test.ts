import assert from 'node:assert/strict';
import test from 'node:test';
import { openClawHttpAmbiguous, openClawHttpDiagnostic } from '../src/sdk/openclaw-api-error.js';

test('classifies the upstream failure without disclosing its body', () => {
  assert.equal(openClawHttpDiagnostic(500, JSON.stringify({error:{message:'LLM request timed out.'}})),
    'HTTP 500; category=upstream_timeout');
  assert.equal(openClawHttpDiagnostic(502, JSON.stringify({error:{message:'terminated'}})),
    'HTTP 502; category=upstream_stream_interrupted');
  const privateBody={error:{message:'timed out; password=SYNTHETIC_SECRET',code:'SYNTHETIC_PRIVATE_CODE'}};
  const result=openClawHttpDiagnostic(500,JSON.stringify(privateBody));
  assert.equal(result,'HTTP 500; category=upstream_timeout');
  assert.doesNotMatch(result,/SYNTHETIC|password/u);
});

test('malformed and unrecognized bodies expose only status and a fixed category', () => {
  for(const body of ['SYNTHETIC_SECRET','{"error":','{"error":{"message":"private account detail"}}']) {
    assert.equal(openClawHttpDiagnostic(503,body),'HTTP 503; category=unclassified');
  }
});

test('provider errors do not become an unsafe whole-task retry based on HTTP status', () => {
  for(const status of [408,425,429,500,504])assert.equal(openClawHttpAmbiguous(status,'{}'),true);
  assert.equal(openClawHttpAmbiguous(401,'{"error":{"type":"api_error"}}'),true);
  assert.equal(openClawHttpAmbiguous(400,'{"error":{"type":"api_error"}}'),true);
  assert.equal(openClawHttpAmbiguous(401,'{"error":{"type":"authentication_error"}}'),false);
});
