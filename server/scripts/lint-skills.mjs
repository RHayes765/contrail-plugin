import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard the skill pack against actuator drift. The adapted sf-skills must
 * never send an agent to tooling Contrail does not have — a refreshed
 * upstream skill quietly reintroducing `sf` CLI steps or force-app paths is
 * exactly the failure mode this catches. Run: `npm run lint:skills`.
 *
 * Contrail's own two skills are linted too: the same rules apply to the
 * whole pack.
 */

const skillsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
);

/** Actuator references that must not appear in any shipped SKILL.md. */
const banned = [
  { re: /\bsf\s+(org|apex|project|data|config|code-analyzer|api|force)\b/i, why: 'sf CLI command — Contrail has no CLI' },
  { re: /\bsfdx\b/i, why: 'sfdx CLI/project reference' },
  { re: /force-app/i, why: 'SFDX project layout — Contrail uses snapshot/staging paths' },
  { re: /sfdx-project\.json/i, why: 'SFDX project file' },
  { re: /run_code_analyzer/i, why: 'DX MCP analyzer tool — no Contrail equivalent' },
  { re: /--target-org/i, why: 'sf CLI org addressing — Contrail names connections' },
  { re: /\bexecute_metadata_action\b/i, why: 'DX MCP generation pipeline — no Contrail equivalent' },
  { re: /\bapex\s+run\s+test\b/i, why: 'standalone test runner — tests run inside validate_deploy' },
];

let failures = 0;
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
}

if (failures > 0) {
  console.error(`\nlint-skills: ${failures} banned actuator reference(s). The pack must speak Contrail.`);
  process.exit(1);
}
console.log('lint-skills: clean.');
