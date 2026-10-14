import { readFileSync } from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ConfigFile, validateConfig } from './schema';

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

/**
 * Parses a YAML (or JSON, which is a subset of YAML) configuration string and
 * validates the result. Throws {@link ConfigParseError} for syntax errors and
 * {@link ConfigValidationError} for schema errors.
 */
export function parseConfigString(source: string, sourceLabel = '<config>'): ConfigFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigParseError(`Failed to parse ${sourceLabel} as YAML/JSON: ${detail}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new ConfigParseError(`Configuration in ${sourceLabel} is empty`);
  }

  return validateConfig(parsed);
}

/**
 * Reads, parses, and validates a configuration file from disk. Both YAML and
 * JSON files are supported.
 */
export function loadConfigFile(configPath: string): ConfigFile {
  let source: string;
  try {
    source = readFileSync(configPath, 'utf8');
  } catch {
    throw new ConfigParseError(`Config file not found: ${configPath}`);
  }

  return parseConfigString(source, configPath);
}
