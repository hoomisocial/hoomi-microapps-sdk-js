/**
 * Size + tree-shaking gate.
 *
 * 1. The full core entry, bundled and minified the way an app bundler would,
 *    must be <= 12 KB min+gzip.
 * 2. Importing a single symbol (HoomiError) must shake out the client/
 *    transport/mock machinery — proof that sideEffects:false holds and the
 *    entry has no import-time work.
 */

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT_FULL = 12 * 1024;
const LIMIT_SHAKEN = 2.5 * 1024;

async function bundle(contents, label) {
  const result = await build({
    stdin: { contents, resolveDir: root, sourcefile: `${label}.js` },
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].contents;
  const gz = gzipSync(code, { level: 9 }).length;
  return { min: code.length, gz };
}

let failed = false;
const check = (label, size, limit) => {
  const ok = size.gz <= limit;
  if (!ok) failed = true;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${size.min} B min, ${size.gz} B min+gzip (limit ${limit} B)`,
  );
};

const full = await bundle(`export * from './dist/index.js';`, 'full-core');
check('core entry (everything)', full, LIMIT_FULL);

const shaken = await bundle(
  `export { HoomiError, PermissionDeniedError } from './dist/index.js';`,
  'errors-only',
);
check('tree-shaken (errors only)', shaken, LIMIT_SHAKEN);

if (shaken.gz >= full.gz) {
  failed = true;
  console.log('FAIL  tree-shaking had no effect (errors-only bundle is not smaller than the full core)');
}

process.exit(failed ? 1 : 0);
