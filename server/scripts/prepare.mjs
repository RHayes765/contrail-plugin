import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

/**
 * Build on install — but only when the TypeScript compiler is present. A
 * production / `--omit=dev` install has no devDependencies, so tsc is absent;
 * in that case skip cleanly instead of hard-failing the whole install. (The
 * lean-bundle install path documented in the README relies on this.)
 */
const require = createRequire(import.meta.url);
try {
  require.resolve('typescript');
} catch {
  console.error('[contrail] prepare: TypeScript not installed (production install) — skipping build.');
  process.exit(0);
}
execSync('tsc -p tsconfig.json', { stdio: 'inherit' });
