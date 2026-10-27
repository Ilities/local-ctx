process.env['LOG_LEVEL'] ??= 'silent';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { LocalContextServer } from '../src/router';
import { OAuthService } from '../src/service/OAuthService';

interface Harness {
  authServerUrl: string;
  resourceServerUrl: string;
  otherAuthServerUrl: string;
  signingKey: KeyLike;
  close: () => Promise<void>;
}

function listen(app: express.Application): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startAuthServer(publicJwk: object) {
  const app = express();
  app.get('/oauth2/jwks', (_req, res) => {
    res.json({ keys: [publicJwk] });
  });
  return listen(app);
}

async function startHarness(): Promise<Harness> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256' };

  const authServer = await startAuthServer(publicJwk);
  // A second authorization server that signs with a different key, used to check that
  // tokens from an unrelated issuer are rejected.
  const other = await generateKeyPair('ES256');
  const otherJwk = { ...(await exportJWK(other.publicKey)), kid: 'other-key', alg: 'ES256' };
  const otherAuthServer = await startAuthServer(otherJwk);

  const port = await freePort();
  const resourceServerUrl = `http://127.0.0.1:${port}`;

  const server = new LocalContextServer(
    {
      port,
      commands: [
        { name: 'memory', command: 'true', path: 'memory' },
        { name: 'filesystem', command: 'true', path: 'filesystem' },
      ],
      oauth: {
        authorizationServerUrl: authServer.url,
        resourceServerUrl,
      },
    },
    new OAuthService({
      authorizationServerUrl: authServer.url,
      resourceServerUrl,
    })
  );
  // Bind on the port the server advertises as its resource server URL.
  const rsServer = await new Promise<Server>((resolve, reject) => {
    const s = server.getApp().listen(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  return {
    authServerUrl: authServer.url,
    otherAuthServerUrl: otherAuthServer.url,
    resourceServerUrl,
    signingKey: privateKey,
    close: async () => {
      await Promise.all(
        [authServer.server, otherAuthServer.server, rsServer].map(
          s => new Promise<void>(resolve => s.close(() => resolve()))
        )
      );
    },
  };
}

async function mintToken(
  key: KeyLike,
  opts: {
    issuer: string;
    audience?: string | string[] | undefined;
    expiresIn?: string;
    kid?: string;
  }
): Promise<string> {
  let jwt = new SignJWT({ scope: 'mcp' })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'test-key' })
    .setIssuer(opts.issuer)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m');
  if (opts.audience !== undefined) {
    jwt = jwt.setAudience(opts.audience);
  }
  return jwt.sign(key);
}

describe('OAuth protection of MCP endpoints (MCP authorization spec 2025-06-18)', () => {
  let h: Harness;

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h.close();
  });

  const mcpUrl = (name: string) => `${h.resourceServerUrl}/${name}`;

  describe('access tokens', () => {
    it('accepts a token issued for the endpoint (GET reaches the handler, returns 405)', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.authServerUrl,
        audience: mcpUrl('memory'),
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 405);
    });

    it('accepts a token whose audience is an array containing the endpoint', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.authServerUrl,
        audience: ['https://unrelated.example.com', mcpUrl('memory')],
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 405);
    });

    it('rejects a token issued for another MCP endpoint on the same server', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.authServerUrl,
        audience: mcpUrl('filesystem'),
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      assert.match(challenge, /error="invalid_token"/);
    });

    it('rejects a token for another resource on the same authorization server (POST too)', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.authServerUrl,
        audience: 'https://some-other-api.example.com/mcp',
      });
      const res = await fetch(mcpUrl('memory'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(res.status, 401);
    });

    it('rejects a token for the server origin without the endpoint path', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.authServerUrl,
        audience: `${h.resourceServerUrl}/`,
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
    });

    it('rejects a token without an audience claim', async () => {
      const token = await mintToken(h.signingKey, { issuer: h.authServerUrl });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
    });

    it('rejects a token from a different issuer', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.otherAuthServerUrl,
        audience: mcpUrl('memory'),
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
    });

    it('rejects a token signed with a key that is not in the JWKS', async () => {
      const rogue = await generateKeyPair('ES256');
      const token = await mintToken(rogue.privateKey, {
        issuer: h.authServerUrl,
        audience: mcpUrl('memory'),
        kid: 'test-key',
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
    });

    it('rejects an expired token', async () => {
      const token = await mintToken(h.signingKey, {
        issuer: h.authServerUrl,
        audience: mcpUrl('memory'),
        expiresIn: '-1m',
      });
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
    });

    it('rejects a malformed bearer token', async () => {
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: 'Bearer not-a-jwt' } });
      assert.equal(res.status, 401);
    });
  });

  describe('401 challenges', () => {
    it('points a request without a token at the metadata of that endpoint', async () => {
      const res = await fetch(mcpUrl('memory'));
      assert.equal(res.status, 401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      assert.match(challenge, /^Bearer /);
      assert.ok(
        challenge.includes(
          `resource_metadata="${h.resourceServerUrl}/.well-known/oauth-protected-resource/memory"`
        ),
        challenge
      );
      assert.doesNotMatch(challenge, /error=/);
    });

    it('points a POST without a token at the metadata of that endpoint', async () => {
      const res = await fetch(mcpUrl('filesystem'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 401);
      assert.ok(
        (res.headers.get('www-authenticate') ?? '').includes(
          `resource_metadata="${h.resourceServerUrl}/.well-known/oauth-protected-resource/filesystem"`
        )
      );
    });

    it('includes invalid_token and the endpoint metadata for an invalid token', async () => {
      const res = await fetch(mcpUrl('memory'), { headers: { Authorization: 'Bearer nope' } });
      const challenge = res.headers.get('www-authenticate') ?? '';
      assert.match(challenge, /error="invalid_token"/);
      assert.ok(
        challenge.includes(
          `resource_metadata="${h.resourceServerUrl}/.well-known/oauth-protected-resource/memory"`
        )
      );
    });
  });

  describe('RFC 9728 protected resource metadata', () => {
    it('serves metadata for each exposed endpoint with its own resource identifier', async () => {
      for (const name of ['memory', 'filesystem']) {
        const res = await fetch(
          `${h.resourceServerUrl}/.well-known/oauth-protected-resource/${name}`
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body['resource'], mcpUrl(name));
        assert.deepEqual(body['authorization_servers'], [h.authServerUrl]);
        assert.deepEqual(body['bearer_methods_supported'], ['header']);
      }
    });

    it('serves the metadata with CORS enabled for browser-based clients', async () => {
      const res = await fetch(`${h.resourceServerUrl}/.well-known/oauth-protected-resource/memory`);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    it('does not serve metadata for an endpoint that is not exposed', async () => {
      const res = await fetch(
        `${h.resourceServerUrl}/.well-known/oauth-protected-resource/unknown`
      );
      assert.equal(res.status, 404);
    });

    it('keeps serving the legacy root metadata document', async () => {
      const res = await fetch(`${h.resourceServerUrl}/.well-known/oauth-protected-resource`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['resource'], `${h.resourceServerUrl}/`);
    });
  });
});

describe('OAuthService resource identifiers', () => {
  it('strips trailing slashes from the configured resource server URL', () => {
    const service = new OAuthService({
      authorizationServerUrl: 'https://auth.example.com',
      resourceServerUrl: 'https://public.example.com/',
    });
    assert.equal(service.getResourceIdentifier('memory'), 'https://public.example.com/memory');
    assert.equal(
      service.getProtectedResourceMetadataUrl('memory'),
      'https://public.example.com/.well-known/oauth-protected-resource/memory'
    );
  });

  it('describes the endpoint in the metadata document', () => {
    const service = new OAuthService({
      authorizationServerUrl: 'https://auth.example.com',
      resourceServerUrl: 'https://public.example.com',
    });
    assert.deepEqual(service.getProtectedResourceMetadata('github'), {
      resource: 'https://public.example.com/github',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
    });
  });
});

describe('server without OAuth configured', () => {
  it('leaves MCP endpoints unauthenticated and serves no metadata', async () => {
    const port = await freePort();
    const server = new LocalContextServer(
      {
        port,
        commands: [{ name: 'memory', command: 'true', path: 'memory' }],
        oauth: undefined,
      },
      new OAuthService(undefined)
    );
    const { server: http, url } = await listen(server.getApp());
    try {
      const get = await fetch(`${url}/memory`);
      assert.equal(get.status, 405);
      const meta = await fetch(`${url}/.well-known/oauth-protected-resource/memory`);
      assert.equal(meta.status, 404);
    } finally {
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });
});
