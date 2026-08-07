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
    if (relPath === 'package.xml' || relPath.endsWith('-meta.xml')) continue;
    const content = Buffer.from(bytes).toString('utf8');
    const name = fileBaseName(relPath);

    if (relPath.startsWith('classes/') && relPath.endsWith('.cls')) {
      push('ApexClass', name, relPath, content);
    } else if (relPath.startsWith('triggers/') && relPath.endsWith('.trigger')) {
      push('ApexTrigger', name, relPath, content);
    } else if (relPath.startsWith('flows/') && relPath.endsWith('.flow')) {
      push('Flow', name, relPath, content);
    } else if (relPath.startsWith('objects/') && relPath.endsWith('.object')) {
      const objectProp = props.get(`CustomObject:${name.toLowerCase()}`);
      push('CustomObject', name, relPath, content);
      for (const block of extractChildBlocks(content, 'fields')) {
        const child = blockFullName(block);
        if (child) push('CustomField', `${name}.${child}`, relPath, block, objectProp);
      }
      for (const block of extractChildBlocks(content, 'validationRules')) {
        const child = blockFullName(block);
        if (child) push('ValidationRule', `${name}.${child}`, relPath, block, objectProp);
      }
    } else if (relPath.startsWith('labels/') && relPath.endsWith('.labels')) {
      const labelsProp = props.get('CustomLabels:customlabels');
      push('CustomLabels', name, relPath, content);
      for (const block of extractChildBlocks(content, 'labels')) {
        const child = blockFullName(block);
        if (child) push('CustomLabel', child, relPath, block, labelsProp);
      }
    } else if (relPath.startsWith('permissionsets/') && relPath.endsWith('.permissionset')) {
      push('PermissionSet', name, relPath, content);
    } else {
      log('debug', 'snapshot file not indexed (unmapped type)', { relPath });
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
  return base.replace(/\.[^.]+$/, '');
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
