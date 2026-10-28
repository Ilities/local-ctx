import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { LocalContextServer, LocalServerConfig } from '../src/router.js';
import { OAuthService } from '../src/service/OAuthService.js';
import { startExpressApp, startTestAuthServer, TestAuthServer } from './helpers.js';
import { generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';

/**
 * Integration tests that cover the resource-server behaviour mandated by the
 * MCP authorization specification (revision 2025-06-18): per-resource audience
 * checking, RFC 9728 metadata documents, and the WWW-Authenticate hint.
 *
 * To avoid spawning real MCP child processes for the "token accepted" cases we
 * build a mini Express app whose protected route only runs the OAuth
 * middleware and then returns 200. That lets us verify the authorization
 * decision in isolation from the StreamableHTTP transport.
 */
describe('OAuth resource server behaviour', () => {
  let authServer: TestAuthServer;

  before(async () => {
    authServer = await startTestAuthServer();
  });

  after(async () => {
    await authServer.close();
  });

  /**
   * Spin up a LocalContextServer bound to an ephemeral port. We need the port
   * before we can compute the resource server URL (so resource identifiers
   * match what clients send), so we probe once with a placeholder port then
   * rebuild.
   */
  async function startRouterServer() {
    const makeConfig = (resourceServerUrl: string): LocalServerConfig => ({
      commands: [
        { name: 'memory', command: 'cat' },
        { name: 'filesystem', command: 'cat' },
      ],
      port: 0,
      oauth: {
        authorizationServerUrl: authServer.issuer,
        resourceServerUrl,
      },
    });

    const probe = new LocalContextServer(
      makeConfig('http://127.0.0.1:0'),
      new OAuthService({
        authorizationServerUrl: authServer.issuer,
        resourceServerUrl: 'http://127.0.0.1:0',
      })
    );
    const probeStarted = await startExpressApp(probe.getApp());
    const port = new URL(probeStarted.baseUrl).port;
    await probeStarted.close();

    const resourceServerUrl = `http://127.0.0.1:${port}`;
    const cfg = makeConfig(resourceServerUrl);
    const server = new LocalContextServer(
      cfg,
      new OAuthService({
        authorizationServerUrl: authServer.issuer,
        resourceServerUrl,
      })
    );
    const started = await startExpressApp(server.getApp());
    return { baseUrl: started.baseUrl, close: started.close, resourceServerUrl };
  }

  /**
   * Spin up a tiny Express app that only mounts the OAuth middleware for a
   * given resource name. Useful for asserting middleware outcomes without
   * triggering any downstream MCP work.
   */
  async function startMiddlewareOnlyServer(resourceName: string) {
    const probe = express();
    const probeStarted = await startExpressApp(probe);
    const port = new URL(probeStarted.baseUrl).port;
    await probeStarted.close();

    const resourceServerUrl = `http://127.0.0.1:${port}`;
    const oauth = new OAuthService({
      authorizationServerUrl: authServer.issuer,
      resourceServerUrl,
    });
    const app = express();
    app.use(express.json());
    app.post(`/${resourceName}`, oauth.getJwtBearerTokenMiddleware(resourceName), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.get(`/.well-known/oauth-protected-resource/${resourceName}`, (_req, res) => {
      res.json(oauth.getProtectedResourceMetadata(resourceName));
    });
    const started = await startExpressApp(app);
    return { baseUrl: started.baseUrl, close: started.close, resourceServerUrl };
  }

  describe('protected resource metadata (RFC 9728)', () => {
    it('serves per-endpoint metadata at /.well-known/oauth-protected-resource/<name>', async () => {
      const { baseUrl, close, resourceServerUrl } = await startRouterServer();

      const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/memory`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
      };
      assert.equal(body.resource, `${resourceServerUrl}/memory`);
      assert.deepEqual(body.authorization_servers, [authServer.issuer]);
      assert.deepEqual(body.bearer_methods_supported, ['header']);

      await close();
    });

    it('serves distinct metadata documents for each exposed endpoint', async () => {
      const { baseUrl, close, resourceServerUrl } = await startRouterServer();

      const [memoryRes, fsRes] = await Promise.all([
        fetch(`${baseUrl}/.well-known/oauth-protected-resource/memory`).then(r => r.json()),
        fetch(`${baseUrl}/.well-known/oauth-protected-resource/filesystem`).then(r => r.json()),
      ]);
      assert.equal((memoryRes as { resource: string }).resource, `${resourceServerUrl}/memory`);
      assert.equal((fsRes as { resource: string }).resource, `${resourceServerUrl}/filesystem`);

      await close();
    });

    it('keeps the top-level /.well-known/oauth-protected-resource working for backwards compatibility', async () => {
      const { baseUrl, close } = await startRouterServer();

      const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { resource: string };
      // Defaults to the first registered resource.
      assert.ok(body.resource.endsWith('/memory'));

      await close();
    });
  });

  describe('WWW-Authenticate on 401', () => {
    it('points at the per-resource metadata URL when the token is missing', async () => {
      const { baseUrl, close, resourceServerUrl } = await startRouterServer();

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 401);
      const wwwAuth = res.headers.get('www-authenticate');
      assert.ok(wwwAuth, 'WWW-Authenticate header must be present');
      assert.match(wwwAuth!, /^Bearer /);
      assert.ok(
        wwwAuth!.includes(
          `resource_metadata="${resourceServerUrl}/.well-known/oauth-protected-resource/memory"`
        ),
        `resource_metadata should point to the per-resource PRM URL. Got: ${wwwAuth}`
      );

      await close();
    });

    it('uses the right per-resource URL for each endpoint', async () => {
      const { baseUrl, close, resourceServerUrl } = await startRouterServer();

      const res = await fetch(`${baseUrl}/filesystem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const wwwAuth = res.headers.get('www-authenticate');
      assert.ok(
        wwwAuth!.includes(
          `resource_metadata="${resourceServerUrl}/.well-known/oauth-protected-resource/filesystem"`
        )
      );

      await close();
    });
  });

  describe('audience-bound token validation', () => {
    it('accepts a token issued for this specific resource', async () => {
      const { baseUrl, close, resourceServerUrl } = await startMiddlewareOnlyServer('memory');

      const token = await authServer.mintToken({
        audience: `${resourceServerUrl}/memory`,
      });

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      assert.equal(res.status, 200);

      await close();
    });

    it('rejects a token issued for a different resource on the same AS', async () => {
      const { baseUrl, close, resourceServerUrl } = await startMiddlewareOnlyServer('memory');

      // Token minted for /filesystem — must NOT be accepted at /memory.
      const token = await authServer.mintToken({
        audience: `${resourceServerUrl}/filesystem`,
      });

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      assert.equal(res.status, 401);
      const wwwAuth = res.headers.get('www-authenticate');
      assert.ok(wwwAuth);
      assert.ok(
        wwwAuth!.includes('/.well-known/oauth-protected-resource/memory'),
        'WWW-Authenticate should still point to the requested resource'
      );

      await close();
    });

    it('rejects a token with no audience claim at all', async () => {
      const { baseUrl, close } = await startMiddlewareOnlyServer('memory');

      const token = await authServer.mintToken({});

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      assert.equal(res.status, 401);

      await close();
    });

    it('rejects a token with the wrong issuer', async () => {
      const { baseUrl, close, resourceServerUrl } = await startMiddlewareOnlyServer('memory');

      const token = await authServer.mintToken({
        audience: `${resourceServerUrl}/memory`,
        issuer: 'https://attacker.example',
      });

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      assert.equal(res.status, 401);

      await close();
    });

    it('rejects a token signed by an unknown key', async () => {
      const { baseUrl, close, resourceServerUrl } = await startMiddlewareOnlyServer('memory');

      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      const token = await authServer.mintTokenWithKey(privateKey, randomUUID(), {
        audience: `${resourceServerUrl}/memory`,
      });

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      assert.equal(res.status, 401);

      await close();
    });

    it('accepts a token whose aud claim is an array containing this resource', async () => {
      const { baseUrl, close, resourceServerUrl } = await startMiddlewareOnlyServer('memory');

      const token = await authServer.mintToken({
        audience: [`${resourceServerUrl}/memory`, 'https://other.example/api'],
      });

      const res = await fetch(`${baseUrl}/memory`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      assert.equal(res.status, 200);

      await close();
    });
  });
});
