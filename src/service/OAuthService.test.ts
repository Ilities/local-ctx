import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Application } from 'express';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import request from 'supertest';
import { LocalContextServer, type LocalServerConfig } from '../router.js';
import { OAuthService } from './OAuthService.js';

const resourceBase = 'https://mcp.example.com';
const memoryResource = `${resourceBase}/memory`;
const filesystemResource = `${resourceBase}/filesystem`;

describe('MCP OAuth authorization', () => {
  let authServer: Server;
  let app: Application;
  let issuer: string;
  let privateKey: KeyLike;
  let publicJwk: JsonWebKey;

  before(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = 'test-key';
    publicJwk.use = 'sig';

    authServer = createServer((req, res) => {
      if (req.url === '/oauth2/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    authServer.listen(0, '127.0.0.1');
    await once(authServer, 'listening');

    const address = authServer.address() as AddressInfo;
    issuer = `http://127.0.0.1:${address.port}`;

    const config: LocalServerConfig = {
      commands: [
        { name: 'memory', command: 'true' },
        { name: 'filesystem', command: 'true' },
      ],
      port: address.port,
      oauth: {
        authorizationServerUrl: issuer,
        resourceServerUrl: resourceBase,
      },
    };

    const localServer = new LocalContextServer(config, new OAuthService(config.oauth));
    app = (localServer as unknown as { app: Application }).app;
  });

  after(async () => {
    if (!authServer.listening) return;
    await new Promise<void>((resolve, reject) =>
      authServer.close(error => (error ? reject(error) : resolve()))
    );
  });

  async function token(audience: string, tokenIssuer = issuer): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(tokenIssuer)
      .setAudience(audience)
      .setSubject('test-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('serves endpoint-specific protected-resource metadata', async () => {
    const response = await request(app).get('/.well-known/oauth-protected-resource/memory');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      resource: memoryResource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });

  it('serves metadata for every exposed endpoint', async () => {
    const response = await request(app).get('/.well-known/oauth-protected-resource/filesystem');

    assert.equal(response.status, 200);
    assert.equal(response.body.resource, filesystemResource);
  });

  it('keeps the older per-endpoint metadata path working', async () => {
    const response = await request(app).get('/memory/.well-known/oauth-protected-resource');

    assert.equal(response.status, 200);
    assert.equal(response.body.resource, memoryResource);
  });

  it('serves root protected-resource metadata for compatibility', async () => {
    const response = await request(app).get('/.well-known/oauth-protected-resource');

    assert.equal(response.status, 200);
    assert.equal(response.body.resource, resourceBase);
  });

  it('points clients at endpoint metadata when authorization is missing', async () => {
    const response = await request(app).post('/memory').send({});

    assert.equal(response.status, 401);
    assert.match(
      response.headers['www-authenticate'] as string,
      /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/memory"/
    );
  });

  it('rejects a token issued for another resource', async () => {
    const response = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${await token(filesystemResource)}`)
      .send({});

    assert.equal(response.status, 401);
    assert.match(response.headers['www-authenticate'] as string, /error="invalid_token"/);
  });

  it('rejects a token from a different issuer', async () => {
    const response = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${await token(memoryResource, 'https://other.example.com')}`)
      .send({});

    assert.equal(response.status, 401);
  });

  it('accepts a token issued for this endpoint', async () => {
    const response = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${await token(memoryResource)}`)
      .send({});

    // The middleware passed and the request reached MCP handling, which rejects
    // this test request before spawning/using a real MCP session.
    assert.notEqual(response.status, 401);
  });
});

describe('OAuth audience override', () => {
  it('uses a configured audience instead of the endpoint URL', async () => {
    const keys = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = 'override-key';
    publicJwk.use = 'sig';

    const authServer = createServer((req, res) => {
      if (req.url === '/oauth2/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    authServer.listen(0, '127.0.0.1');
    await once(authServer, 'listening');

    try {
      const address = authServer.address() as AddressInfo;
      const issuer = `http://127.0.0.1:${address.port}`;
      const config: LocalServerConfig = {
        commands: [{ name: 'memory', command: 'true' }],
        port: address.port,
        oauth: {
          authorizationServerUrl: issuer,
          resourceServerUrl: resourceBase,
          audience: 'https://api.example.com',
        },
      };

      const localServer = new LocalContextServer(config, new OAuthService(config.oauth));
      const app = (localServer as unknown as { app: Application }).app;
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'override-key' })
        .setIssuer(issuer)
        .setAudience('https://api.example.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);

      const response = await request(app)
        .post('/memory')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      assert.notEqual(response.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        authServer.close(error => (error ? reject(error) : resolve()))
      );
    }
  });
});
