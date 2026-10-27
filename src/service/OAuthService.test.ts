import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { KeyLike, JWK } from 'jose';
import { OAuthService } from './OAuthService';
import { OAuthController } from '../controller/OAuthController';

interface TestKeys {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

async function makeKeys(kid: string): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, kid };
}

async function listen(app: express.Application): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  // keep a handle so we can close later
  (app as unknown as { __server: typeof server }).__server = server;
  return port;
}

async function close(app: express.Application): Promise<void> {
  const server = (app as unknown as { __server?: import('node:http').Server }).__server;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
}

async function mintToken(
  keys: TestKeys,
  issuer: string,
  audience: string | string[]
): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(keys.privateKey);
}

test('OAuth authorization follows the MCP authorization spec', async t => {
  const serverKeys = await makeKeys('server-key');
  const attackerKeys = await makeKeys('attacker-key');

  // Authorization server: serves the JWKS used to verify tokens.
  const asApp = express();
  asApp.get('/jwks', (_req, res) => res.json({ keys: [serverKeys.publicJwk] }));
  const asPort = await listen(asApp);
  const authorizationServerUrl = `http://127.0.0.1:${asPort}`;

  // Resource server: the local-ctx instance exposing /memory and /files.
  const rsApp = express();
  const rsPort = await listen(rsApp);
  const rsBase = `http://127.0.0.1:${rsPort}`;

  const service = new OAuthService({
    authorizationServerUrl,
    jwksPath: '/jwks',
    resourceServerUrl: rsBase,
  });
  const controller = new OAuthController(service);

  for (const name of ['memory', 'files']) {
    rsApp
      .route(`/.well-known/oauth-protected-resource/${name}`)
      .get(controller.getProtectedResourceHandler(name));
    rsApp.post(`/${name}`, service.getJwtBearerTokenMiddleware(name), (_req, res) =>
      res.status(200).json({ ok: true })
    );
  }

  t.after(() => close(asApp));
  t.after(() => close(rsApp));

  const post = (path: string, token?: string) =>
    fetch(`${rsBase}${path}`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  await t.test('accepts a token issued for this endpoint', async () => {
    const token = await mintToken(serverKeys, authorizationServerUrl, `${rsBase}/memory`);
    const res = await post('/memory', token);
    assert.equal(res.status, 200);
  });

  await t.test('rejects a token issued for a different resource on the same server', async () => {
    const token = await mintToken(serverKeys, authorizationServerUrl, `${rsBase}/files`);
    const res = await post('/memory', token);
    assert.equal(res.status, 401);
    const www = res.headers.get('www-authenticate') ?? '';
    assert.match(www, /Bearer/);
    assert.match(www, /error="invalid_token"/);
    assert.ok(
      www.includes(`resource_metadata="${rsBase}/.well-known/oauth-protected-resource/memory"`),
      `WWW-Authenticate should point at the /memory metadata, got: ${www}`
    );
  });

  await t.test('rejects a token signed by a different key', async () => {
    const token = await mintToken(attackerKeys, authorizationServerUrl, `${rsBase}/memory`);
    const res = await post('/memory', token);
    assert.equal(res.status, 401);
  });

  await t.test('rejects a missing token and advertises resource metadata', async () => {
    const res = await post('/memory');
    assert.equal(res.status, 401);
    const www = res.headers.get('www-authenticate') ?? '';
    assert.ok(
      www.includes(`resource_metadata="${rsBase}/.well-known/oauth-protected-resource/memory"`)
    );
  });

  await t.test(
    'serves RFC 9728 metadata per endpoint with the right resource identifier',
    async () => {
      const res = await fetch(`${rsBase}/.well-known/oauth-protected-resource/memory`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.resource, `${rsBase}/memory`);
      assert.deepEqual(body.authorization_servers, [authorizationServerUrl]);
      assert.deepEqual(body.bearer_methods_supported, ['header']);
    }
  );

  await t.test('the advertised metadata URL actually serves matching metadata', async () => {
    const token = await mintToken(serverKeys, authorizationServerUrl, `${rsBase}/files`);
    const denied = await post('/memory', token);
    const www = denied.headers.get('www-authenticate') ?? '';
    const match = www.match(/resource_metadata="([^"]+)"/);
    assert.ok(match, 'expected resource_metadata in WWW-Authenticate');
    const metaRes = await fetch(match[1]!);
    assert.equal(metaRes.status, 200);
    const meta = await metaRes.json();
    assert.equal(meta.resource, `${rsBase}/memory`);
  });

  await t.test('accepts a token whose audience list includes this endpoint', async () => {
    const token = await mintToken(serverKeys, authorizationServerUrl, [
      'https://elsewhere.example/mcp',
      `${rsBase}/memory`,
    ]);
    const res = await post('/memory', token);
    assert.equal(res.status, 200);
  });
});
