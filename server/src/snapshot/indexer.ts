import { createHash } from 'node:crypto';
import type { FileProperties } from '../salesforce/metadataSoap.js';
import { log } from '../core/log.js';

/**
 * Turns an extracted snapshot tree into the normalized artifact index.
 * Container files are split into addressable children — a consultant asks
 * about Account.MyField__c, not about the 4000-line Account.object file.
 */
export interface IndexedArtifact {
  type: string;
  apiName: string;
  filePath: string;
  contentHash: string;
  lastModifiedDate: string | null;
  lastModifiedBy: string | null;
  retrievedAt: string;
  /** Text fed to the FTS index (and, for children, the extracted fragment). */
  content: string;
}

/** One-file-per-artifact types: top-level snapshot dir + extension → type. */
const SIMPLE_DIR_TYPES: Array<{ dir: string; ext: string; type: string }> = [
  { dir: 'classes', ext: '.cls', type: 'ApexClass' },
  { dir: 'triggers', ext: '.trigger', type: 'ApexTrigger' },
  { dir: 'flows', ext: '.flow', type: 'Flow' },
  { dir: 'permissionsets', ext: '.permissionset', type: 'PermissionSet' },
  { dir: 'tabs', ext: '.tab', type: 'CustomTab' },
  { dir: 'flexipages', ext: '.flexipage', type: 'FlexiPage' },
  { dir: 'applications', ext: '.app', type: 'CustomApplication' },
  { dir: 'reportTypes', ext: '.reportType', type: 'ReportType' },
  { dir: 'pages', ext: '.page', type: 'ApexPage' },
  { dir: 'globalValueSets', ext: '.globalValueSet', type: 'GlobalValueSet' },
  { dir: 'connectedApps', ext: '.connectedApp', type: 'ConnectedApp' },
  { dir: 'namedCredentials', ext: '.namedCredential', type: 'NamedCredential' },
  { dir: 'externalCredentials', ext: '.externalCredential', type: 'ExternalCredential' },
  { dir: 'platformEventChannels', ext: '.platformEventChannel', type: 'PlatformEventChannel' },
  {
    dir: 'platformEventChannelMembers',
    ext: '.platformEventChannelMember',
    type: 'PlatformEventChannelMember',
  },
  {
    dir: 'managedEventSubscriptions',
    ext: '.managedEventSubscription',
    type: 'ManagedEventSubscription',
  },
  { dir: 'layouts', ext: '.layout', type: 'Layout' },
  { dir: 'customMetadata', ext: '.md', type: 'CustomMetadata' },
];

/**
 * S29: folder-based analytics types. Content files nest one level under the
 * type dir (reports/Ops/Weekly.report → api_name 'Ops/Weekly' — the folder
 * segment is PART of the name; dropping it would collide same-leaf reports
 * across folders on the index's UNIQUE key and kill the whole refresh), and
 * the folder's own definition IS a -meta.xml directly under the dir
 * (reports/Ops-meta.xml → ReportFolder 'Ops'), which must be caught BEFORE
 * the generic -meta.xml skip.
 */
const FOLDERED_DIR_TYPES: Array<{ dir: string; ext: string; type: string; folderType: string }> = [
  { dir: 'reports', ext: '.report', type: 'Report', folderType: 'ReportFolder' },
  { dir: 'dashboards', ext: '.dashboard', type: 'Dashboard', folderType: 'DashboardFolder' },
];

export function indexSnapshotFiles(
  files: Map<string, Uint8Array>,
  fileProps: FileProperties[],
  retrievedAt: string,
): IndexedArtifact[] {
  const props = new Map<string, FileProperties>();
  for (const p of fileProps) props.set(`${p.type}:${p.fullName.toLowerCase()}`, p);

  const artifacts: IndexedArtifact[] = [];
  const push = (
    type: string,
    apiName: string,
    filePath: string,
    content: string,
    parentProp?: FileProperties,
  ) => {
    const prop = props.get(`${type}:${apiName.toLowerCase()}`) ?? parentProp;
    artifacts.push({
      type,
      apiName,
      filePath,
      contentHash: sha256(content),
      lastModifiedDate: prop?.lastModifiedDate || null,
      lastModifiedBy: prop?.lastModifiedByName || null,
      retrievedAt,
      content,
    });
  };

  for (const [relPath, bytes] of files) {
    if (relPath === 'package.xml') continue;

    // Foldered analytics dirs first — their folder definitions are -meta.xml
    // files the generic skip below would otherwise swallow.
    const foldered = FOLDERED_DIR_TYPES.find((f) => relPath.startsWith(`${f.dir}/`));
    if (foldered) {
      const inner = relPath.slice(foldered.dir.length + 1);
      if (inner.endsWith('-meta.xml')) {
        const name = inner.slice(0, -'-meta.xml'.length);
        // A folder definition, unless it's a content file's meta sibling
        // (reports never ship those, but guard anyway).
        if (!name.endsWith(foldered.ext)) {
          push(
            foldered.folderType,
            name.split('/').map(decodeSegment).join('/'),
            relPath,
            Buffer.from(bytes).toString('utf8'),
          );
        }
        continue;
      }
      if (inner.endsWith(foldered.ext)) {
        const apiName = inner
          .slice(0, -foldered.ext.length)
          .split('/')
          .map(decodeSegment)
          .join('/');
        push(foldered.type, apiName, relPath, Buffer.from(bytes).toString('utf8'));
        continue;
      }
      log('debug', 'snapshot file not indexed (unmapped type)', { relPath });
      continue;
    }

    if (relPath.endsWith('-meta.xml')) continue;
    const content = Buffer.from(bytes).toString('utf8');
    const name = fileBaseName(relPath);

    if (relPath.startsWith('objects/') && relPath.endsWith('.object')) {
      const objectProp = props.get(`CustomObject:${name.toLowerCase()}`);
      push('CustomObject', name, relPath, content);
      const childTags: Array<[string, string]> = [
        ['fields', 'CustomField'],
        ['validationRules', 'ValidationRule'],
        ['listViews', 'ListView'],
        ['recordTypes', 'RecordType'],
      ];
      for (const [tag, childType] of childTags) {
        for (const block of extractChildBlocks(content, tag)) {
          const child = blockFullName(block);
          if (child) push(childType, `${name}.${child}`, relPath, block, objectProp);
        }
      }
    } else if (relPath.startsWith('labels/') && relPath.endsWith('.labels')) {
      const labelsProp = props.get('CustomLabels:customlabels');
      push('CustomLabels', name, relPath, content);
      for (const block of extractChildBlocks(content, 'labels')) {
        const child = blockFullName(block);
        if (child) push('CustomLabel', child, relPath, block, labelsProp);
      }
    } else {
      const simple = SIMPLE_DIR_TYPES.find(
        (s) => relPath.startsWith(`${s.dir}/`) && relPath.endsWith(s.ext),
      );
      if (simple) {
        push(simple.type, name, relPath, content);
      } else {
        log('debug', 'snapshot file not indexed (unmapped type)', { relPath });
      }
    }
  }
  return artifacts;
}

/**
 * Extract raw child XML blocks (e.g. every <fields>…</fields>) from a
 * container document. Regex over the raw text on purpose: it preserves the
 * exact source fragment for display and hashing.
 */
export function extractChildBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
  return xml.match(re) ?? [];
}

/** Find one child block by its <fullName> (used for retrieve_metadata fragments). */
export function findChildBlock(xml: string, tag: string, fullName: string): string | null {
  for (const block of extractChildBlocks(xml, tag)) {
    if (blockFullName(block)?.toLowerCase() === fullName.toLowerCase()) return block;
  }
  return null;
}

function blockFullName(block: string): string | null {
  const m = block.match(/<fullName>([^<]+)<\/fullName>/);
  return m?.[1]?.trim() ?? null;
}

function fileBaseName(relPath: string): string {
  const base = relPath.split('/').at(-1) ?? relPath;
  return decodeSegment(base.replace(/\.[^.]+$/, ''));
}

/**
 * Decode ONE path segment. Retrieve zips percent-encode special characters in
 * FILE names (a layout named "Account (Marketing) Layout" arrives as
 * "Account %28Marketing%29 Layout.layout") while fileProperties carry the
 * decoded fullName. Decode so the index key matches the real API name; a
 * literal '%' that is not an escape leaves the name as-is. Foldered types
 * decode per segment so the '/' separator is never touched.
 */
function decodeSegment(stripped: string): string {
  try {
    return decodeURIComponent(stripped);
  } catch {
    // A stray literal '%' alongside real escapes: decode escape-by-escape so
    // the valid ones resolve and the stray survives, instead of one bad byte
    // poisoning the whole name.
    return stripped.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
