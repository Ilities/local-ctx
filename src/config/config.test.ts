import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigString, ConfigParseError } from './parse';
import { validateConfig, ConfigValidationError } from './schema';

test('parses a full YAML configuration', () => {
  const config = parseConfigString(`
commands:
  - name: memory
    command: npx -y @modelcontextprotocol/server-memory
  - name: filesystem
    command: npx -y @modelcontextprotocol/server-filesystem /tmp
port: 8123
oauth:
  authorizationServerUrl: https://example.workos.com
  jwksPath: /oauth2/jwks
`);

  assert.deepEqual(config, {
    commands: [
      { name: 'memory', command: 'npx -y @modelcontextprotocol/server-memory' },
      { name: 'filesystem', command: 'npx -y @modelcontextprotocol/server-filesystem /tmp' },
    ],
    port: 8123,
    oauth: {
      authorizationServerUrl: 'https://example.workos.com',
      jwksPath: '/oauth2/jwks',
    },
  });
});

test('accepts JSON because it is valid YAML', () => {
  const config = parseConfigString(
    JSON.stringify({
      commands: [{ name: 'memory', command: 'npx -y @modelcontextprotocol/server-memory' }],
      port: 8000,
    })
  );

  assert.deepEqual(config.commands, [
    { name: 'memory', command: 'npx -y @modelcontextprotocol/server-memory' },
  ]);
  assert.equal(config.port, 8000);
});

test('accepts an optional command path', () => {
  const config = parseConfigString(`
commands:
  - name: memory
    command: npx -y @modelcontextprotocol/server-memory
    path: /custom
`);

  assert.equal(config.commands?.[0]?.path, '/custom');
});

test('rejects a command missing its command field', () => {
  assert.throws(
    () =>
      parseConfigString(`
commands:
  - name: memory
`),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /commands\[0\]\.command/);
      return true;
    }
  );
});

test('rejects duplicate command names', () => {
  assert.throws(
    () =>
      parseConfigString(`
commands:
  - name: memory
    command: a
  - name: memory
    command: b
`),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /duplicated/);
      return true;
    }
  );
});

test('rejects an out-of-range port', () => {
  assert.throws(
    () =>
      parseConfigString(`
commands:
  - name: memory
    command: a
port: 70000
`),
    /port/
  );
});

test('rejects oauth without an authorization server url', () => {
  assert.throws(
    () =>
      parseConfigString(`
commands:
  - name: memory
    command: a
oauth:
  jwksPath: /oauth2/jwks
`),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /oauth\.authorizationServerUrl/);
      return true;
    }
  );
});

test('rejects unknown keys', () => {
  assert.throws(
    () =>
      parseConfigString(`
commands:
  - name: memory
    command: a
  - name: other
    command: b
    extra: true
`),
    /unknown key/
  );
});

test('rejects malformed YAML', () => {
  assert.throws(() => parseConfigString('commands: [unterminated'), ConfigParseError);
});

test('rejects empty input', () => {
  assert.throws(() => parseConfigString('# just a comment\n'), ConfigParseError);
});

test('validateConfig reports every problem at once', () => {
  assert.throws(
    () =>
      validateConfig({
        commands: [{ name: '', command: '' }, { command: 'b' }],
        port: -1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.ok(error.problems.length >= 3);
      return true;
    }
  );
});
