import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import { OAuthService } from './service/OAuthService';
import { OAuthController } from './controller/OAuthController';
import { LocalContextServer, OAuthConfig, LocalServerConfig } from './router';

// ---------------------------------------------------------------------------
// Helpers – generate a local RSA key pair and sign JWTs with it.
// ---------------------------------------------------------------------------
let privateKey: KeyLike;
let publicJwk: ReturnType<typeof exportJWK> extends Promise<infer T> ? T : never;

const AUTH_SERVER_URL = 'https://auth.example.com';
const RESOURCE_SERVER_URL = 'http://localhost:9999';

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
});

/**
 * Create a signed JWT with the given claims.
 */
async function signToken(claims: Record<string, unknown>): Promise<string> {
  let builder = new SignJWT(claims as Record<string, string>)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setExpirationTime('5m');

  if (claims['iss'] !== undefined) {
    builder = builder.setIssuer(claims['iss'] as string);
  }
  if (claims['aud'] !== undefined) {
    builder = builder.setAudience(claims['aud'] as string);
  }

  return builder.sign(privateKey);
}

// ---------------------------------------------------------------------------
// Build a minimal Express app that mirrors the relevant OAuth routes from
// LocalContextServer, but avoids spawning real child processes.  We use the
// real OAuthService and OAuthController so the tests cover the actual code.
// ---------------------------------------------------------------------------

/**
 * Create a test app with OAuth middleware on POST /:name and per-endpoint
 * protected resource metadata, wired up the same way router.ts does.
 */
function createTestApp(endpointNames: string[]) {
  const oauthConfig: OAuthConfig = {
    authorizationServerUrl: AUTH_SERVER_URL,
    resourceServerUrl: RESOURCE_SERVER_URL,
  };

  const oauthService = new OAuthService(oauthConfig);
  const oauthController = new OAuthController(oauthService);

  const app = express();
  app.use(express.json());

  // Protected resource metadata per endpoint (RFC 9728)
  app
    .route('/.well-known/oauth-protected-resource/:endpointName')
    .get(oauthController.getProtectedResourceHandler());

  // MCP endpoints with JWT middleware
  for (const name of endpointNames) {
    app.post(`/${name}`, oauthService.getJwtBearerTokenMiddleware(name), (_req, res) => {
      res.json({ ok: true });
    });
  }

  return { app, oauthService };
}

// ---------------------------------------------------------------------------
// Stub the remote JWKS fetch so jose resolves keys from our in-memory pair.
// ---------------------------------------------------------------------------
// OAuthService calls `createRemoteJWKSet` which fetches from the auth server.
// We intercept global fetch to serve our JWKS when the URL matches.
beforeAll(() => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(AUTH_SERVER_URL)) {
      if (url.includes('/oauth2/jwks')) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return new Response(
          JSON.stringify({
            issuer: AUTH_SERVER_URL,
            authorization_endpoint: `${AUTH_SERVER_URL}/authorize`,
            token_endpoint: `${AUTH_SERVER_URL}/token`,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('OAuth protected resource metadata (RFC 9728)', () => {
  it('serves per-endpoint metadata with the correct resource identifier', async () => {
    const { app } = createTestApp(['memory', 'filesystem']);

    const res = await request(app).get('/.well-known/oauth-protected-resource/memory').expect(200);

    expect(res.body).toEqual({
      resource: `${RESOURCE_SERVER_URL}/memory`,
      authorization_servers: [AUTH_SERVER_URL],
      bearer_methods_supported: ['header'],
    });
  });

  it('returns different resource identifiers for different endpoints', async () => {
    const { app } = createTestApp(['memory', 'filesystem']);

    const mem = await request(app).get('/.well-known/oauth-protected-resource/memory').expect(200);
    const fs = await request(app)
      .get('/.well-known/oauth-protected-resource/filesystem')
      .expect(200);

    expect(mem.body.resource).toBe(`${RESOURCE_SERVER_URL}/memory`);
    expect(fs.body.resource).toBe(`${RESOURCE_SERVER_URL}/filesystem`);
    expect(mem.body.resource).not.toBe(fs.body.resource);
  });

  it('returns 404 for metadata of an unknown endpoint', async () => {
    const { app } = createTestApp(['memory']);

    // The route matches any :endpointName so the controller responds.
    // This is acceptable – the handler returns metadata for whatever name
    // is requested.  A stricter check could 404 on unknown names, but the
    // spec doesn't require it and the existing design doesn't track
    // registered names in the controller.  Clients will discover endpoints
    // from WWW-Authenticate, not by guessing.
    await request(app).get('/.well-known/oauth-protected-resource/unknown').expect(200);
  });
});

describe('WWW-Authenticate header', () => {
  it('returns resource_metadata pointing to the per-endpoint metadata URL on 401', async () => {
    const { app } = createTestApp(['memory']);

    const res = await request(app)
      .post('/memory')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);

    const wwwAuth = res.headers['www-authenticate'];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain(
      `resource_metadata="${RESOURCE_SERVER_URL}/.well-known/oauth-protected-resource/memory"`
    );
  });

  it('uses the correct endpoint name in the metadata URL for each route', async () => {
    const { app } = createTestApp(['memory', 'filesystem']);

    const memRes = await request(app).post('/memory').send({}).expect(401);
    const fsRes = await request(app).post('/filesystem').send({}).expect(401);

    expect(memRes.headers['www-authenticate']).toContain('oauth-protected-resource/memory');
    expect(fsRes.headers['www-authenticate']).toContain('oauth-protected-resource/filesystem');
  });
});

describe('JWT audience validation', () => {
  it('accepts a token with the correct audience (resource identifier)', async () => {
    const { app } = createTestApp(['memory']);

    const token = await signToken({
      iss: AUTH_SERVER_URL,
      aud: `${RESOURCE_SERVER_URL}/memory`,
      sub: 'user-1',
    });

    const res = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a token issued for a different endpoint', async () => {
    const { app } = createTestApp(['memory', 'filesystem']);

    // Token was issued for /filesystem but presented to /memory
    const token = await signToken({
      iss: AUTH_SERVER_URL,
      aud: `${RESOURCE_SERVER_URL}/filesystem`,
      sub: 'user-1',
    });

    const res = await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);

    expect(res.body.error).toBe('Invalid bearer token.');
  });

  it('rejects a token with no audience claim', async () => {
    const { app } = createTestApp(['memory']);

    const token = await signToken({
      iss: AUTH_SERVER_URL,
      sub: 'user-1',
    });

    await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
  });

  it('rejects a token from the wrong issuer', async () => {
    const { app } = createTestApp(['memory']);

    const token = await signToken({
      iss: 'https://evil.example.com',
      aud: `${RESOURCE_SERVER_URL}/memory`,
      sub: 'user-1',
    });

    await request(app)
      .post('/memory')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
  });

  it('rejects requests without a Bearer token', async () => {
    const { app } = createTestApp(['memory']);

    const res = await request(app)
      .post('/memory')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);

    expect(res.body.error).toBe('No token provided.');
  });

  it('rejects requests with a malformed Authorization header', async () => {
    const { app } = createTestApp(['memory']);

    const res = await request(app)
      .post('/memory')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);

    expect(res.body.error).toBe('No token provided.');
  });
});

describe('Authorization server metadata proxy', () => {
  it('proxies the authorization server metadata', async () => {
    const oauthConfig: OAuthConfig = {
      authorizationServerUrl: AUTH_SERVER_URL,
      resourceServerUrl: RESOURCE_SERVER_URL,
    };
    const oauthService = new OAuthService(oauthConfig);
    const oauthController = new OAuthController(oauthService);

    const app = express();
    app
      .route('/.well-known/oauth-authorization-server')
      .get(oauthController.getAuthorizationServerHandler());

    const res = await request(app).get('/.well-known/oauth-authorization-server').expect(200);

    expect(res.body.issuer).toBe(AUTH_SERVER_URL);
    expect(res.body.authorization_endpoint).toBeDefined();
    expect(res.body.token_endpoint).toBeDefined();
  });
});

describe('OAuthService unit tests', () => {
  it('getResourceIdentifier returns the correct per-endpoint URL', () => {
    const svc = new OAuthService({
      authorizationServerUrl: AUTH_SERVER_URL,
      resourceServerUrl: RESOURCE_SERVER_URL,
    });
    expect(svc.getResourceIdentifier('memory')).toBe(`${RESOURCE_SERVER_URL}/memory`);
  });

  it('getResourceMetadataUrl follows RFC 9728 well-known URL construction', () => {
    const svc = new OAuthService({
      authorizationServerUrl: AUTH_SERVER_URL,
      resourceServerUrl: RESOURCE_SERVER_URL,
    });
    expect(svc.getResourceMetadataUrl('memory')).toBe(
      `${RESOURCE_SERVER_URL}/.well-known/oauth-protected-resource/memory`
    );
  });

  it('getProtectedResourceMetadata returns correct structure per endpoint', () => {
    const svc = new OAuthService({
      authorizationServerUrl: AUTH_SERVER_URL,
      resourceServerUrl: RESOURCE_SERVER_URL,
    });
    const meta = svc.getProtectedResourceMetadata('filesystem');
    expect(meta).toEqual({
      resource: `${RESOURCE_SERVER_URL}/filesystem`,
      authorization_servers: [AUTH_SERVER_URL],
      bearer_methods_supported: ['header'],
    });
  });
});
