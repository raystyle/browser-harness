/**
 * Build page-resident SDKs: assets/sdk/<name>.ts -> <name>.min.js (iife).
 * esbuild is a devDependency — the produced bundles are self-contained, the
 * zero-runtime-dependency rule is untouched (G002).
 */
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sdk');
const entries = readdirSync(sdkDir).filter(f => f.endsWith('.ts'));
if (!entries.length) { console.error('build-sdk: no .ts entries in assets/sdk'); process.exit(1); }

for (const f of entries) {
  const outfile = path.join(sdkDir, f.replace(/\.ts$/, '.min.js'));
  await build({
    entryPoints: [path.join(sdkDir, f)],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    legalComments: 'none',
    outfile,
  });
  console.log(`sdk: ${f} -> ${path.relative(process.cwd(), outfile)}`);
}
