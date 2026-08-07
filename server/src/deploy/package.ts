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
};

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
