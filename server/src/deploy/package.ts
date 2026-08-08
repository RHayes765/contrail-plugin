import { strToU8, zipSync } from 'fflate';
import { escapeXml } from '../salesforce/xml.js';
import { ContrailError } from '../core/errors.js';
import type { ContrailDb } from '../core/db.js';
import type { SnapshotStore } from '../snapshot/store.js';
import type { ConnectionRecord } from '../core/types.js';

/**
 * Deploy package construction: turns proposed components into a Metadata API
 * deploy zip (metadata format), and analyzes the proposal against the local
 * snapshot so the human sees adds vs modifications vs deletions — with
 * data-loss risks flagged — before anything reaches the org.
 */

export interface ProposedComponent {
  type: string;
  api_name: string;
  /** Full source for file types; the child XML block for CustomField/ValidationRule/CustomLabel. */
  content: string;
}

export interface ProposedDeletion {
  type: string;
  api_name: string;
}

export interface ComponentChange {
  type: string;
  api_name: string;
  change: 'add' | 'modify' | 'unchanged_content' | 'delete';
  warnings: string[];
}

/** File placement per deployable type (metadata format). */
const FILE_TYPES: Record<
  string,
  { dir: string; ext: string; metaRoot?: string }
> = {
  ApexClass: { dir: 'classes', ext: '.cls', metaRoot: 'ApexClass' },
  ApexTrigger: { dir: 'triggers', ext: '.trigger', metaRoot: 'ApexTrigger' },
  Flow: { dir: 'flows', ext: '.flow' },
  CustomObject: { dir: 'objects', ext: '.object' },
  PermissionSet: { dir: 'permissionsets', ext: '.permissionset' },
  Profile: { dir: 'profiles', ext: '.profile' },
  CustomTab: { dir: 'tabs', ext: '.tab' },
  FlowDefinition: { dir: 'flowDefinitions', ext: '.flowDefinition' },
};

const XMLNS_META = 'http://soap.sforce.com/2006/04/metadata';

/** Metadata body that deactivates a flow (all versions off). */
export function flowDeactivationXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<FlowDefinition xmlns="${XMLNS_META}">\n` +
    `    <activeVersionNumber>0</activeVersionNumber>\n</FlowDefinition>\n`
  );
}

/** Child types that deploy wrapped inside a container document. */
const CHILD_TYPES: Record<
  string,
  { containerRoot: string; dir: string; ext: string; tag: string; parentFromName: (n: string) => string }
> = {
  CustomField: {
    containerRoot: 'CustomObject',
    dir: 'objects',
    ext: '.object',
    tag: 'fields',
    parentFromName: (n) => n.split('.')[0] ?? '',
  },
  ValidationRule: {
    containerRoot: 'CustomObject',
    dir: 'objects',
    ext: '.object',
    tag: 'validationRules',
    parentFromName: (n) => n.split('.')[0] ?? '',
  },
  CustomLabel: {
    containerRoot: 'CustomLabels',
    dir: 'labels',
    ext: '.labels',
    tag: 'labels',
    parentFromName: () => 'CustomLabels',
  },
};

const NAME_RE = /^[A-Za-z0-9_.\- ]+$/;
const XMLNS = 'http://soap.sforce.com/2006/04/metadata';

export interface BuiltPackage {
  zip: Buffer;
  files: string[];
  packageXml: string;
  destructiveXml: string | null;
}

export function buildDeployZip(
  components: ProposedComponent[],
  deletions: ProposedDeletion[],
  apiVersionNumber: string,
  metaXmlLookup: (type: string, apiName: string) => string | null,
): BuiltPackage {
  const files = new Map<string, Uint8Array>();
  const members = new Map<string, string[]>();
  const addMember = (type: string, name: string) => {
    const list = members.get(type) ?? [];
    list.push(name);
    members.set(type, list);
  };

  // Children targeting the same container merge into one document.
  const containers = new Map<
    string,
    { root: string; path: string; blocks: string[] }
  >();

  for (const c of components) {
    validateTypeAndName(c.type, c.api_name);
    const fileSpec = FILE_TYPES[c.type];
    if (fileSpec) {
      const short = c.api_name;
      const path = `${fileSpec.dir}/${short}${fileSpec.ext}`;
      files.set(path, strToU8(c.content));
      if (fileSpec.metaRoot) {
        const meta =
          metaXmlLookup(c.type, c.api_name) ??
          `<?xml version="1.0" encoding="UTF-8"?>\n<${fileSpec.metaRoot} xmlns="${XMLNS}">\n` +
            `    <apiVersion>${escapeXml(apiVersionNumber)}</apiVersion>\n` +
            `    <status>Active</status>\n</${fileSpec.metaRoot}>\n`;
        files.set(`${path}-meta.xml`, strToU8(meta));
      }
      addMember(c.type, c.api_name);
      continue;
    }
    const childSpec = CHILD_TYPES[c.type];
    if (childSpec) {
      const parent = childSpec.parentFromName(c.api_name);
      if (!parent) {
        throw new ContrailError(
          `${c.type} names are dotted (Parent.Child), got "${c.api_name}"`,
          'bad_component',
        );
      }
      const path = `${childSpec.dir}/${parent}${childSpec.ext}`;
      const key = `${childSpec.containerRoot}:${path}`;
      const container =
        containers.get(key) ?? { root: childSpec.containerRoot, path, blocks: [] };
      container.blocks.push(c.content.trim());
      containers.set(key, container);
      addMember(c.type, c.api_name);
      continue;
    }
    throw new ContrailError(
      `Type "${c.type}" is not deployable through Contrail yet. Deployable types: ` +
        `${[...Object.keys(FILE_TYPES), ...Object.keys(CHILD_TYPES)].join(', ')}.`,
      'bad_component',
    );
  }

  for (const container of containers.values()) {
    if (files.has(container.path)) {
      throw new ContrailError(
        `Cannot deploy both the full ${container.path} file and individual children of it ` +
          `in one request — pick one form.`,
        'bad_component',
      );
    }
    const doc =
      `<?xml version="1.0" encoding="UTF-8"?>\n<${container.root} xmlns="${XMLNS}">\n` +
      container.blocks.map((b) => `    ${b}`).join('\n') +
      `\n</${container.root}>\n`;
    files.set(container.path, strToU8(doc));
  }

  for (const d of deletions) {
    validateTypeAndName(d.type, d.api_name);
  }

  const packageXml = manifestXml(members, apiVersionNumber, 'Package');
  files.set('package.xml', strToU8(packageXml));

  let destructiveXml: string | null = null;
  if (deletions.length > 0) {
    const delMembers = new Map<string, string[]>();
    for (const d of deletions) {
      const list = delMembers.get(d.type) ?? [];
      list.push(d.api_name);
      delMembers.set(d.type, list);
    }
    destructiveXml = manifestXml(delMembers, apiVersionNumber, 'Package');
    // Post-destructive: additive changes land before deletions, so a rename
    // (add new + delete old) works in one deploy.
    files.set('destructiveChangesPost.xml', strToU8(destructiveXml));
  }

  return {
    zip: Buffer.from(zipSync(Object.fromEntries(files))),
    files: [...files.keys()].sort(),
    packageXml,
    destructiveXml,
  };
}

function manifestXml(
  members: Map<string, string[]>,
  apiVersionNumber: string,
  root: 'Package',
): string {
  const types = [...members.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([type, names]) =>
        `    <types>\n${names
          .sort()
          .map((n) => `        <members>${escapeXml(n)}</members>`)
          .join('\n')}\n        <name>${escapeXml(type)}</name>\n    </types>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${XMLNS}">\n${types}\n` +
    `    <version>${escapeXml(apiVersionNumber)}</version>\n</${root}>\n`
  );
}

function validateTypeAndName(type: string, name: string): void {
  if (!/^[A-Za-z]+$/.test(type)) throw new ContrailError(`invalid type "${type}"`, 'bad_component');
  if (!NAME_RE.test(name) || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new ContrailError(`invalid component name "${name}"`, 'bad_component');
  }
}

/**
 * Classify each proposed component against the local snapshot and flag
 * data-loss risks. Deletions are always listed and always prominent.
 */
export function analyzeChanges(
  db: ContrailDb,
  store: SnapshotStore,
  conn: ConnectionRecord,
  components: ProposedComponent[],
  deletions: ProposedDeletion[],
): { changes: ComponentChange[]; destructive: ComponentChange[] } {
  const changes: ComponentChange[] = [];
  for (const c of components) {
    // A FlowDefinition setting activeVersionNumber 0 is a flow deactivation —
    // label it plainly so the approval page doesn't read as a mysterious "ADD".
    if (c.type === 'FlowDefinition' && /<activeVersionNumber>\s*0\s*<\/activeVersionNumber>/.test(c.content)) {
      changes.push({
        type: c.type,
        api_name: c.api_name,
        change: 'modify',
        warnings: [`DEACTIVATES flow ${c.api_name} — turns off its active version.`],
      });
      continue;
    }
    const existing = db.getArtifact(conn.id, c.type, c.api_name);
    const warnings: string[] = [];
    let change: ComponentChange['change'];
    if (!existing) {
      change = 'add';
    } else {
      const oldContent = existing.filePath
        ? readOldContent(store, conn, c.type, c.api_name, existing.filePath)
        : null;
      change = oldContent !== null && oldContent.trim() === c.content.trim()
        ? 'unchanged_content'
        : 'modify';
      if (c.type === 'CustomField' && oldContent) {
        const oldType = oldContent.match(/<type>([^<]+)<\/type>/)?.[1];
        const newType = c.content.match(/<type>([^<]+)<\/type>/)?.[1];
        if (oldType && newType && oldType !== newType) {
          warnings.push(
            `FIELD TYPE CHANGE ${oldType} → ${newType} — possible irreversible data loss`,
          );
        }
      }
    }
    changes.push({ type: c.type, api_name: c.api_name, change, warnings });
  }

  const destructive: ComponentChange[] = deletions.map((d) => {
    const warnings: string[] = ['DELETION — cannot be undone by rollback'];
    const existing = db.getArtifact(conn.id, d.type, d.api_name);
    if (!existing) {
      warnings.push('not present in the local snapshot — verify the name before approving');
    }
    return { type: d.type, api_name: d.api_name, change: 'delete', warnings };
  });

  return { changes, destructive };
}

export interface PermissionCoverage {
  /** Components that need a permission and are NOT granted anywhere in this package. */
  uncovered: Array<{ type: string; api_name: string; permission: string }>;
  /** True if the package itself contains a PermissionSet or Profile. */
  has_permission_container: boolean;
  warning: string | null;
}

/** A single thing that needs a permission grant to be usable. */
interface PermissionNeed {
  type: string;
  api_name: string;
  permission: string;
  kind: 'field' | 'object' | 'class' | 'tab';
}

/** Custom entities (need explicit object permissions); standard objects don't. */
function isCustomEntity(name: string): boolean {
  return /__(c|b|e|x)$/i.test(name);
}

/** Extract the fullNames of inline <fields> in a CustomObject .object body. */
function inlineFieldNames(objectXml: string): string[] {
  const names: string[] = [];
  for (const block of objectXml.match(/<fields>[\s\S]*?<\/fields>/g) ?? []) {
    const m = block.match(/<fullName>([^<]+)<\/fullName>/);
    if (m?.[1]) names.push(m[1].trim());
  }
  return names;
}

function permissionBlocks(text: string, tag: string): string[] {
  return text.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')) ?? [];
}

/**
 * A grant counts only if the component is named in the right permission block
 * AND the enabling flag is on — a mention with readable/allowRead/enabled=false
 * (or a Hidden tab) is NOT coverage. False "covered" would defeat the warning.
 */
function isGranted(containerText: string, need: PermissionNeed): boolean {
  const named = (block: string, tag: string, name: string): boolean =>
    new RegExp(`<${tag}>\\s*${escapeRegex(name)}\\s*</${tag}>`, 'i').test(block);
  const flagOn = (block: string, flag: string): boolean =>
    new RegExp(`<${flag}>\\s*true\\s*</${flag}>`, 'i').test(block);

  switch (need.kind) {
    case 'field':
      return permissionBlocks(containerText, 'fieldPermissions').some(
        (b) => named(b, 'field', need.api_name) && flagOn(b, 'readable'),
      );
    case 'object':
      return permissionBlocks(containerText, 'objectPermissions').some(
        (b) => named(b, 'object', need.api_name) && flagOn(b, 'allowRead'),
      );
    case 'class':
      return permissionBlocks(containerText, 'classAccesses').some(
        (b) => named(b, 'apexClass', need.api_name) && flagOn(b, 'enabled'),
      );
    case 'tab': {
      const blocks = [
        ...permissionBlocks(containerText, 'tabVisibilities'),
        ...permissionBlocks(containerText, 'tabSettings'),
      ];
      return blocks.some((b) => {
        if (!named(b, 'tab', need.api_name)) return false;
        const vis = b.match(/<visibility>\s*([^<]+?)\s*<\/visibility>/i)?.[1] ?? '';
        return !/^(hidden|none)$/i.test(vis);
      });
    }
  }
}

/**
 * Check whether permission-needing components in the package are granted by a
 * PermissionSet/Profile ALSO in the package. Advisory only — it never blocks a
 * deploy, it warns so the human isn't surprised when new metadata is invisible.
 * Custom fields authored inline in a full .object file are enumerated too, and a
 * grant must be actually enabled (not merely mentioned) to count as coverage.
 */
export function analyzePermissionCoverage(components: ProposedComponent[]): PermissionCoverage {
  const containers = components.filter((c) => c.type === 'PermissionSet' || c.type === 'Profile');
  const hasContainer = containers.length > 0;
  const containerText = containers.map((c) => c.content).join('\n');

  const needs: PermissionNeed[] = [];
  for (const c of components) {
    if (c.type === 'CustomField') {
      needs.push({ type: 'CustomField', api_name: c.api_name, permission: 'field-level security (FLS)', kind: 'field' });
    } else if (c.type === 'ApexClass') {
      needs.push({ type: 'ApexClass', api_name: c.api_name, permission: 'Apex class access', kind: 'class' });
    } else if (c.type === 'CustomTab') {
      needs.push({ type: 'CustomTab', api_name: c.api_name, permission: 'tab visibility', kind: 'tab' });
    } else if (c.type === 'CustomObject') {
      if (isCustomEntity(c.api_name)) {
        needs.push({ type: 'CustomObject', api_name: c.api_name, permission: 'object permissions', kind: 'object' });
      }
      // Fields authored inline in the object file still need FLS.
      for (const field of inlineFieldNames(c.content)) {
        needs.push({
          type: 'CustomField',
          api_name: `${c.api_name}.${field}`,
          permission: 'field-level security (FLS)',
          kind: 'field',
        });
      }
    }
  }

  const uncovered: PermissionCoverage['uncovered'] = needs
    .filter((n) => !isGranted(containerText, n))
    .map((n) => ({ type: n.type, api_name: n.api_name, permission: n.permission }));

  let warning: string | null = null;
  if (uncovered.length > 0) {
    const list = uncovered.map((u) => `${u.type}:${u.api_name} (${u.permission})`).join('; ');
    warning = hasContainer
      ? `These new components are not granted by the permission set/profile in this package and ` +
        `will be invisible or inaccessible to users until permissions are set: ${list}.`
      : `This package adds ${uncovered.length} component(s) that need permissions but includes no ` +
        `permission set or profile to grant them — they will deploy but stay invisible or ` +
        `inaccessible until you set permissions (deploy a permission set alongside, or grant FLS/` +
        `access afterward): ${list}.`;
  }
  return { uncovered, has_permission_container: hasContainer, warning };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readOldContent(
  store: SnapshotStore,
  conn: ConnectionRecord,
  type: string,
  apiName: string,
  filePath: string,
): string | null {
  const file = store.readCurrentFile(conn.id, filePath);
  if (file === null) return null;
  const child = CHILD_TYPES[type];
  if (!child) return file;
  // Child artifacts live inside their container file; extract the block.
  const childName = type === 'CustomLabel' ? apiName : apiName.split('.').slice(1).join('.');
  const re = new RegExp(`<${child.tag}>[\\s\\S]*?</${child.tag}>`, 'g');
  for (const block of file.match(re) ?? []) {
    const m = block.match(/<fullName>([^<]+)<\/fullName>/);
    if (m?.[1]?.toLowerCase() === childName.toLowerCase()) return block;
  }
  return null;
}
