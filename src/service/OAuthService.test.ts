import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { after, before, describe, it } from 'node:test';
import { OAuthService } from './OAuthService.js';
import { LocalContextServer, type LocalServerConfig } from '../router.js';

const issuer = 'https://auth.example.com';
const resourceBase = 'https://mcp.example.com';
const memoryResource = `${resourceBase}/memory`;

describe('MCP OAuth authorization', () => {
  let server: Server;
  let app: ReturnType<typeof express>;
  let privateKey: import('jose').KeyLike;
  let publicJwk: JsonWebKey;

  before(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = 'test-key';
    publicJwk.use = 'sig';

    server = createServer((req, res) => {
      if (req.url === '/oauth2/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config: LocalServerConfig = {
      commands: [{ name: 'memory', command: 'true' }],
      port: address.port,
      oauth: {
        authorizationServerUrl: `http://127.0.0.1:${address.port}`,
        resourceServerUrl: resourceBase,
      },
    };
    const localServer = new LocalContextServer(config, new OAuthService(config.oauth));
    app = (localServer as unknown as { app: ReturnType<typeof express> }).app;
  });

  after(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  async function token(audience: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      .setAudience(audience)
      .setSubject('test-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('serves endpoint-specific RFC 9728 metadata', async () => {
    const response = await request(app).get('/memory/.well-known/oauth-protected-resource');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      resource: memoryResource,
      authorization_servers: [`http://127.0.0.1:${(server.address() as AddressInfo).port}`],
      bearer_methods_supported: ['header'],
    });
  });

  it('serves the root protected-resource metadata endpoint for compatibility', async () => {
    const response = await request(app).get('/.well-known/oauth-protected-resource');

    assert.equal(response.status, 200);
    assert.equal(response.body.resource, resourceBase);
  });

  it('advertises the endpoint metadata URL when authorization is missing', async () => {
    const response = await request(app).post('/memory').send({});

    assert.equal(response.status, 401);
    assert.match(
      response.headers['www-authenticate'],
      /resource_metadata="https:\/\/mcp\.example\.com\/memory\/\.well-known\/oauth-protected-resource"/
    );
  });

  it('rejects a valid issuer token with an audience for another resource', async () => {
    const response = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${await token(`${resourceBase}/filesystem`)}`)
      .send({});

    assert.equal(response.status, 401);
  });

  it('accepts a valid token for this endpoint', async () => {
    const response = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${await token(memoryResource)}`)
      .send({});

    // The middleware passed and the request reached MCP handling (which returns 500
    // because this test does not spawn the configured child process).
    assert.equal(response.status, 406);
  });
});
