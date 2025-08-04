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
    // Node.js built-in modules
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
    // Dependencies that have dynamic requires
    'express',
    'body-parser',
    'cors',
    'dotenv',
    'yargs',
    'jose',
    '@modelcontextprotocol/sdk',
  ],
});

console.log('Build completed successfully!');
