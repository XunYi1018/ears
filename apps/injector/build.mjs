import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(HERE, 'src/bundle/entry.ts')],
  bundle: true,
  outfile: join(HERE, 'dist/ears.iife.js'),
  format: 'iife',
  target: ['chrome108'],
  platform: 'browser',
  minify: false,
  sourcemap: 'inline',
  logLevel: 'info',
});
