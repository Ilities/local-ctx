import * as esbuild from 'esbuild';

const entryPoints = ['./src/index.ts'];

await esbuild.build({
  entryPoints,
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  // Mark Node.js built-in modules and problematic dependencies as external
  external: [
    // Node.js built-in modules (both with and without node: prefix)
    'path',
    'fs',
    'os',
    'util',
    'events',
    'stream',
    'http',
    'https',
    'net',
    'crypto',
    'zlib',
    'buffer',
    'string_decoder',
    'querystring',
    'url',
    // Node.js built-in modules with node: prefix
    'node:path',
    'node:fs',
    'node:os',
    'node:util',
    'node:events',
    'node:stream',
    'node:http',
    'node:https',
    'node:net',
    'node:crypto',
    'node:zlib',
    'node:buffer',
    'node:string_decoder',
    'node:querystring',
    'node:url',
    // Dependencies that have dynamic requires
    'express',
    'body-parser',
    'cors',
    'dotenv',
    'yargs',
    'jose',
    '@modelcontextprotocol/sdk',
    // Add pino and its dependencies
    'pino',
    'pino-pretty',
  ],
});

console.log('Build completed successfully!');
