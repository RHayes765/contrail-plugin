import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard the skill pack against actuator drift. The adapted sf-skills must
 * never send an agent to tooling Contrail does not have — a refreshed
 * upstream skill quietly reintroducing `sf` CLI steps or force-app paths is
 * exactly the failure mode this catches. Run: `npm run lint:skills`.
 *
 * Contrail's own skills are linted too: the same rules apply to the whole
 * pack.
 *
 * HTML assets (skills/<name>/assets/**\/*.html) get a second rule set: a
 * shipped page must reference nothing on the network and must not build
 * markup from strings. render_flow fills one of them with org-controlled flow
 * XML, so an HTML-string sink or a remote resource there is a real hole, not
 * a style point.
 */

const skillsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
);

/** Actuator references that must not appear in any shipped SKILL.md. */
const banned = [
  { re: /\bsf\s+(org|apex|project|data|config|code-analyzer|api|force|lightning)\b/i, why: 'sf CLI command — Contrail has no CLI' },
  { re: /\bsfdx\b/i, why: 'sfdx CLI/project reference' },
  { re: /force-app/i, why: 'SFDX project layout — Contrail uses snapshot/staging paths' },
  { re: /sfdx-project\.json/i, why: 'SFDX project file' },
  { re: /run_code_analyzer/i, why: 'DX MCP analyzer tool — no Contrail equivalent' },
  { re: /--target-org/i, why: 'sf CLI org addressing — Contrail names connections' },
  { re: /\bexecute_metadata_action\b/i, why: 'DX MCP generation pipeline — no Contrail equivalent' },
  { re: /\bapex\s+run\s+test\b/i, why: 'sf CLI test invocation — Contrail runs tests via validate_deploy or run_apex_tests' },
  // S30: the agent lifecycle CLI. `sf agent publish/activate/deactivate/
  // preview` have NO Contrail path — the skills hand those steps to the
  // human, never to a CLI Contrail does not have.
  { re: /\bsf\s+agent\b/i, why: 'sf agent lifecycle CLI — no Contrail path; hand off to the human' },
];

/** HTML-string sinks that must not appear in any shipped HTML asset. */
const htmlSinks = [
  { re: /innerHTML/, why: 'innerHTML — build the nodes and set textContent instead' },
  { re: /outerHTML/, why: 'outerHTML — build the nodes and set textContent instead' },
  { re: /insertAdjacentHTML/, why: 'insertAdjacentHTML — build the nodes and set textContent instead' },
  { re: /document\.write/, why: 'document.write — build the nodes and set textContent instead' },
];

/** The one URL prefix an HTML asset may carry: XML namespace identifiers, never fetched. */
const ALLOWED_URL_PREFIX = 'http://www.w3.org/';

/** Every .html file under a directory, at any depth, sorted. */
function htmlFilesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFilesUnder(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) out.push(full);
  }
  return out.sort();
}

let failures = 0;
let htmlFailures = 0;
for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillMd = path.join(skillsRoot, entry.name, 'SKILL.md');
  if (!fs.existsSync(skillMd)) continue;
  const lines = fs.readFileSync(skillMd, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { re, why } of banned) {
      if (re.test(line)) {
        failures += 1;
        console.error(`${entry.name}/SKILL.md:${i + 1}: ${why}\n    ${line.trim()}`);
      }
    }
  });

  for (const file of htmlFilesUnder(path.join(skillsRoot, entry.name, 'assets'))) {
    const rel = path.relative(skillsRoot, file).replaceAll(path.sep, '/');
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const m of line.matchAll(/https?:\/\//gi)) {
          if (line.startsWith(ALLOWED_URL_PREFIX, m.index)) continue;
          htmlFailures += 1;
          console.error(
            `${rel}:${i + 1}: network URL — an HTML asset may reference nothing on the network ` +
              `(only ${ALLOWED_URL_PREFIX} namespace identifiers)\n    ${line.trim()}`,
          );
        }
        for (const { re, why } of htmlSinks) {
          if (re.test(line)) {
            htmlFailures += 1;
            console.error(`${rel}:${i + 1}: ${why}\n    ${line.trim()}`);
          }
        }
      });
  }
}

if (failures > 0) {
  console.error(`\nlint-skills: ${failures} banned actuator reference(s). The pack must speak Contrail.`);
}
if (htmlFailures > 0) {
  console.error(
    `\nlint-skills: ${htmlFailures} problem(s) in HTML assets. A shipped page loads nothing ` +
      `from the network and builds no markup from strings.`,
  );
}
if (failures > 0 || htmlFailures > 0) process.exit(1);
console.log('lint-skills: clean.');
