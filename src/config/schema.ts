import type { CommandConfig } from '../router';

export interface OAuthFileConfig {
  authorizationServerUrl: string;
  jwksPath?: string;
}

export interface ConfigFile {
  commands?: CommandConfig[];
  port?: number;
  corsOrigin?: string | string[] | boolean;
  oauth?: OAuthFileConfig;
}

export class ConfigValidationError extends Error {
  public readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

const ROOT_KEYS = new Set(['commands', 'port', 'corsOrigin', 'oauth']);
const COMMAND_KEYS = new Set(['name', 'command', 'path']);
const OAUTH_KEYS = new Set(['authorizationServerUrl', 'jwksPath']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function reportUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
  problems: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push(`${label} contains unknown key \`${key}\``);
    }
  }
}

function validateCommands(value: unknown, problems: string[]): CommandConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    problems.push('`commands` must be an array');
    return undefined;
  }

  if (value.length === 0) {
    problems.push('`commands` must contain at least one command');
    return undefined;
  }

  const commands: CommandConfig[] = [];
  const names = new Set<string>();

  value.forEach((entry: unknown, index: number) => {
    const label = `commands[${index}]`;

    if (!isPlainObject(entry)) {
      problems.push(`${label} must be an object`);
      return;
    }

    reportUnknownKeys(entry, COMMAND_KEYS, label, problems);

    const name = entry['name'];
    const command = entry['command'];
    const commandPath = entry['path'];

    if (!isNonEmptyString(name)) {
      problems.push(`${label}.name must be a non-empty string`);
    } else if (names.has(name)) {
      problems.push(`${label}.name "${name}" is duplicated`);
    } else {
      names.add(name);
    }

    if (!isNonEmptyString(command)) {
      problems.push(`${label}.command must be a non-empty string`);
    }

    if (commandPath !== undefined && typeof commandPath !== 'string') {
      problems.push(`${label}.path must be a string when provided`);
    }

    if (
      isNonEmptyString(name) &&
      isNonEmptyString(command) &&
      (commandPath === undefined || typeof commandPath === 'string')
    ) {
      const parsed: CommandConfig = { name, command };
      if (typeof commandPath === 'string') {
        parsed.path = commandPath;
      }
      commands.push(parsed);
    }
  });

  return commands;
}

function validatePort(value: unknown, problems: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    problems.push('`port` must be an integer between 1 and 65535');
    return undefined;
  }

  return value;
}

function validateCorsOrigin(
  value: unknown,
  problems: string[]
): string | string[] | boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value as string[];
  }

  problems.push('`corsOrigin` must be a string, an array of strings, or a boolean');
  return undefined;
}

function validateOAuth(value: unknown, problems: string[]): OAuthFileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    problems.push('`oauth` must be an object');
    return undefined;
  }

  reportUnknownKeys(value, OAUTH_KEYS, 'oauth', problems);

  const authorizationServerUrl = value['authorizationServerUrl'];
  const jwksPath = value['jwksPath'];

  if (!isNonEmptyString(authorizationServerUrl)) {
    problems.push('`oauth.authorizationServerUrl` must be a non-empty string');
  }

  if (jwksPath !== undefined && typeof jwksPath !== 'string') {
    problems.push('`oauth.jwksPath` must be a string when provided');
  }

  if (
    !isNonEmptyString(authorizationServerUrl) ||
    (jwksPath !== undefined && typeof jwksPath !== 'string')
  ) {
    return undefined;
  }

  const oauth: OAuthFileConfig = { authorizationServerUrl };
  if (typeof jwksPath === 'string') {
    oauth.jwksPath = jwksPath;
  }
  return oauth;
}

/**
 * Validates an already-parsed configuration object.
 *
 * Returns the same data narrowed to {@link ConfigFile}, or throws a
 * {@link ConfigValidationError} listing every problem found.
 */
export function validateConfig(value: unknown): ConfigFile {
  if (!isPlainObject(value)) {
    throw new ConfigValidationError(['configuration must be a mapping/object']);
  }

  const problems: string[] = [];

  reportUnknownKeys(value, ROOT_KEYS, 'configuration', problems);

  const commands = validateCommands(value['commands'], problems);
  const port = validatePort(value['port'], problems);
  const corsOrigin = validateCorsOrigin(value['corsOrigin'], problems);
  const oauth = validateOAuth(value['oauth'], problems);

  if (problems.length > 0) {
    throw new ConfigValidationError(problems);
  }

  const config: ConfigFile = {};
  if (commands !== undefined) {
    config.commands = commands;
  }
  if (port !== undefined) {
    config.port = port;
  }
  if (corsOrigin !== undefined) {
    config.corsOrigin = corsOrigin;
  }
  if (oauth !== undefined) {
    config.oauth = oauth;
  }
  return config;
}
