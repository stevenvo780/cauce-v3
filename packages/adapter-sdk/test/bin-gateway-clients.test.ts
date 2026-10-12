import assert from 'node:assert/strict';
import test from 'node:test';
import { configureGatewayHttpClients } from '../src/bin/shared.js';
import { configureDefaultBlobClient, defaultBlobClient } from '../src/sdk/blob-client.js';
import { configureDefaultContextIngestClient, ContextIngestClient, defaultContextIngestClient } from '../src/sdk/context-ingest-client.js';

test('startup wiring configures the context ingest client with the blob client credentials', () => {
  configureGatewayHttpClients({
    relayUrl: 'wss://gateway.example:8443/v3/ws',
    mutualTls: { certFile: '/tmp/fixture-cert.pem', keyFile: '/tmp/fixture-key.pem', caFile: '/tmp/fixture-ca.pem' },
    developmentIdentity: false, alias: 'argos',
  }, 'Steven');
  try {
    const ingest = defaultContextIngestClient();
    assert.ok(ingest instanceof ContextIngestClient);
    assert.equal(ingest.baseUrl, 'https://gateway.example:8443');
    assert.ok(defaultBlobClient() !== undefined);
  } finally {
    configureDefaultContextIngestClient(undefined);
    configureDefaultBlobClient(undefined);
  }
});
