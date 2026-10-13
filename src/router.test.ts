import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { LocalContextServer } from './router.js';
import { HealthController } from './controller/HealthController.js';
import { LocalServerRegistry } from './service/LocalServerRegistry.js';
import { OAuthService } from './service/OAuthService.js';

test('GET /health reports the server is up and lists configured MCP servers', async () => {
  const server = new LocalContextServer(
    {
      commands: [{ name: 'memory', command: 'echo hi', path: 'memory' }],
      port: 0,
      oauth: undefined,
    },
    new OAuthService(undefined)
  );

  const httpServer: Server = server.start();
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', () => resolve());
      httpServer.once('error', reject);
    });

    const { port } = httpServer.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', servers: ['memory'] });
  } finally {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  }
});

test('HealthController returns status and configured server names', () => {
  const registry = new LocalServerRegistry();
  registry.registerLocalMcp({ name: 'filesystem', command: 'echo hi', path: 'filesystem' });
  registry.registerLocalMcp({ name: 'memory', command: 'echo hi', path: 'memory' });

  const controller = new HealthController(registry);
  let payload: unknown;
  const res = {
    json: (body: unknown) => {
      payload = body;
      return res;
    },
  } as unknown as Response;

  controller.getHealthHandler()({} as Request, res);

  assert.deepEqual(payload, { status: 'ok', servers: ['filesystem', 'memory'] });
});
