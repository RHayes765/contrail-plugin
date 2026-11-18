import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- a build script: plain .mjs, with no type declarations.
import { ignoredSkillFiles } from '../../scripts/ignored-skills.mjs';

/**
 * The release's ignored-skill-file gate. The repo's `.gitignore` rules are
 * unanchored, so they match under skills/ as well; a file they catch passes
 * every local gate and then is missing from the .mcpb, the zip and the plugin.
 * Driven on a temp git repo that carries the repo's REAL .gitignore, so a rule
 * added there is exercised here too.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const hasGit = spawnSync('git', ['--version']).status === 0;

let tmp: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
}

function put(rel: string): void {
  const abs = path.join(tmp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x\n', 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-skillgate-'));
  if (!hasGit) return;
  git('init', '-q');
  // Only the repo's own rules: no global excludes file, no template excludes.
  fs.writeFileSync(path.join(tmp, '.git', 'info', 'exclude'), '', 'utf8');
  const noExcludes = path.join(tmp, '.git', 'no-excludes');
  fs.writeFileSync(noExcludes, '', 'utf8');
  git('config', 'core.excludesFile', noExcludes.split(path.sep).join('/'));
  fs.copyFileSync(path.join(repoRoot, '.gitignore'), path.join(tmp, '.gitignore'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('ignoredSkillFiles', () => {
  it('lists every ignored skill file that would ship, and nothing else', () => {
    put('skills/demo/SKILL.md');
    put('skills/demo/assets/page.html');
    put('skills/demo/assets/dist/helper.js'); // dist/
    put('skills/demo/examples/run.log'); // *.log
    put('skills/demo/node_modules/pkg/index.js'); // node_modules/
    // Dotfiles: ignored, but mcpb.mjs filters them and read_skill never serves them.
    put('skills/demo/.DS_Store');
    put('skills/demo/.cache/out.log');
    // Tracked despite the rule: it ships, so it is not listed.
    put('skills/demo/assets/dist/tracked.js');
    git('add', '-f', 'skills/demo/assets/dist/tracked.js');
    // Ignored, but outside skills/.
    put('dist/other.js');
    put('server/build.log');

    expect(ignoredSkillFiles(tmp).sort()).toEqual([
      'skills/demo/assets/dist/helper.js',
      'skills/demo/examples/run.log',
      'skills/demo/node_modules/pkg/index.js',
    ]);
  });

  it('is empty when nothing under skills/ is ignored', () => {
    put('skills/demo/SKILL.md');
    put('skills/demo/assets/page.html');
    put('skills/demo/.DS_Store');
    expect(ignoredSkillFiles(tmp)).toEqual([]);
  });
});

describe('release.mjs', () => {
  it('refuses on an ignored skill file before it builds, commits or tags anything', () => {
    const release = fs.readFileSync(path.join(repoRoot, 'server', 'scripts', 'release.mjs'), 'utf8');
    expect(release).toContain("import { ignoredSkillFiles } from './ignored-skills.mjs';");
    const gate = release.indexOf('ignoredSkillFiles(repoRoot)');
    expect(gate).toBeGreaterThan(-1);
    expect(release.indexOf('if (ignoredSkills.length > 0) {', gate)).toBeGreaterThan(gate);
    for (const later of ["run('npm run bundle')", "run('npm run mcpb')", "run('git add -A', repoRoot)"]) {
      expect(release.indexOf(later), later).toBeGreaterThan(gate);
    }
  });
});
