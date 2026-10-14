#!/usr/bin/env node

import { LocalContextServer, CommandConfig, LocalServerConfig } from './router';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { OAuthService } from './service/OAuthService';
import { ConfigFile, loadConfigFile } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const DEFAULT_CONFIG_FILENAME = 'config.json';

interface ResolvedConfigPath {
  path: string;
  // A path supplied explicitly (via --config or CONFIG_PATH) is a hard error if
  // it cannot be loaded; a discovered default config is only a warning.
  explicit: boolean;
}

function resolveConfigPath(cliConfigPath?: string): ResolvedConfigPath | undefined {
  if (cliConfigPath) {
    return { path: cliConfigPath, explicit: true };
  }

  const envConfigPath = process.env['CONFIG_PATH'];
  if (envConfigPath) {
    return { path: envConfigPath, explicit: true };
  }

  const defaultConfigPath = path.join(__dirname, DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(defaultConfigPath)) {
    return { path: defaultConfigPath, explicit: false };
  }

  return undefined;
}

function loadConfigFromFile(configPath?: string): ConfigFile {
  const resolved = resolveConfigPath(configPath);
  if (!resolved) {
    return {};
  }

  try {
    const config = loadConfigFile(resolved.path);
    console.log(`Loaded configuration from: ${resolved.path}`);
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resolved.explicit) {
      console.error(message);
      process.exit(1);
    }
    console.error(`Error loading default config file: ${message}`);
    return {};
  }
}

function getEnvConfig(): Partial<LocalServerConfig> {
  const config: Partial<LocalServerConfig> = {};

  if (process.env['PORT']) {
    config.port = parseInt(process.env['PORT'], 10);
  }

  if (process.env['COMMANDS']) {
    try {
      config.commands = JSON.parse(process.env['COMMANDS']);
    } catch (error) {
      console.error('Error parsing COMMANDS environment variable:', error);
    }
  }

  return config;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('config', {
      alias: 'c',
      type: 'string',
      description: 'Path to JSON or YAML configuration file',
    })
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Port number for the server',
      default: 8000,
    })
    .option('commands', {
      type: 'string',
      description: 'JSON string of commands configuration',
    })
    .option('authorizationServerUrl', {
      type: 'string',
      description: 'JSON string of commands configuration',
    })
    .help()
    .parseAsync();

  // Load configuration in order of precedence: CLI args > env vars > config file > defaults
  // The config file path itself comes from --config, then CONFIG_PATH, then a
  // default config.json next to the entrypoint.
  const fileConfig = loadConfigFromFile(argv.config);
  const envConfig = getEnvConfig();

  // Parse commands from CLI if provided
  let cliCommands: CommandConfig[] = [];
  if (argv.commands) {
    try {
      cliCommands = JSON.parse(argv.commands);
    } catch (error) {
      console.error('Error parsing commands argument:', error);
      process.exit(1);
    }
  }

  // Merge configurations with CLI args taking precedence
  const resolvedPort = argv.port || envConfig.port || fileConfig.port || 8000;
  const finalConfig: LocalServerConfig = {
    commands:
      cliCommands.length > 0 ? cliCommands : envConfig.commands || fileConfig.commands || [],
    port: resolvedPort,
    oauth: fileConfig.oauth
      ? { ...fileConfig.oauth, resourceServerUrl: `http://localhost:${resolvedPort}` }
      : undefined,
  };

  console.log(finalConfig);
  if (!finalConfig.commands || finalConfig.commands.length === 0) {
    console.error(
      'Error: No commands configured. Please provide commands via config file, environment variables, or CLI arguments.'
    );
    console.log('\nExample config.json (YAML is also supported):');
    console.log(
      JSON.stringify(
        {
          commands: [
            {
              name: 'memento',
              command: 'npx -y @modelcontextprotocol/server-memory',
            },
          ],
          port: 8000,
          oauth: {
            authorizationServerUrl: 'https://your-auth-server.example.com',
            jwksPath: '/optional-jwks-path',
          },
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  console.log('Starting LocalContextServer with configuration:');
  console.log(`- Port: ${finalConfig.port}`);
  console.log(`- Commands: ${finalConfig.commands.length}`);

  finalConfig.commands.forEach(cmd => {
    console.log(
      `  - ${cmd.name}: ${cmd.command} -> http://localhost:${finalConfig.port}/${cmd.name}`
    );
  });

  const oAuthService = new OAuthService(finalConfig.oauth);

  const server = new LocalContextServer(finalConfig, oAuthService);
  server.start();
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM. Shutting down gracefully...');
  process.exit(0);
});

main().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
