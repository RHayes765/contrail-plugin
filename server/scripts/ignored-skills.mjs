import { execFileSync } from 'node:child_process';

/**
 * Files under skills/ that git ignores, as repo-relative forward-slash paths.
 * release.mjs refuses to cut a release while any exist.
 *
 * Why: the repo's ignore rules are unanchored (`dist/`, `*.log`,
 * `node_modules/`), so they match under skills/ too. An ignored skill file is
 * present in the working tree, so every local gate passes (the local mcpb build
 * stages it, and its packed-vs-staged check compares only what was staged).
 * But `git add -A` skips it, so it is missing from CI's clean checkout (which
 * packs the .mcpb), from the teammate zip (tracked files only) and from the
 * plugin clone, and read_skill answers `no_such_file` when an agent asks for
 * it.
 *
 * Dotfiles (any path segment starting with ".") are left out: mcpb.mjs filters
 * them and read_skill never serves them, so a stray .DS_Store does not block a
 * release. A file that is tracked despite matching a rule (`git add -f`) is not
 * listed: it ships.
 */
export function ignoredSkillFiles(repoRoot) {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', 'skills'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => file && !file.split('/').some((segment) => segment.startsWith('.')));
}
