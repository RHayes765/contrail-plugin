import { asArray, parseXml } from '../salesforce/xml.js';
import type { DependencyEdge } from '../core/types.js';
import type { IndexedArtifact } from '../snapshot/indexer.js';

/**
 * Contrail's own reference extractor. Complements the org's
 * MetadataComponentDependency API (which is beta, lags, and misses some
 * relationships) with deterministic extraction from the snapshot source.
 * Precision over recall is NOT the goal here — a dependency graph for blast
 * radius wants recall; the agent can dismiss false positives with the source
 * in hand.
 */

export interface Ref {
  toType: string;
  toName: string;
}

/** Extract references from one flow's XML. */
export function extractFlowRefs(xml: string): Ref[] {
  const refs: RefSet = new RefSet();
  let doc: Record<string, unknown>;
  try {
    doc = parseXml(xml);
  } catch {
    return [];
  }
  const flow = (doc.Flow ?? doc.flow ?? {}) as Record<string, unknown>;

  const objectsFrom = (key: string) => {
    for (const node of asArray(flow[key] as Record<string, unknown>[])) {
      if (node && typeof node === 'object' && typeof node.object === 'string') {
        refs.add('CustomObject', node.object);
        collectFieldRefs(node, String(node.object), refs);
      }
    }
  };
  objectsFrom('recordCreates');
  objectsFrom('recordLookups');
  objectsFrom('recordUpdates');
  objectsFrom('recordDeletes');

  const start = flow.start as Record<string, unknown> | undefined;
  if (start && typeof start.object === 'string') {
    refs.add('CustomObject', start.object);
    collectFieldRefs(start, start.object, refs);
  }

  for (const node of asArray(flow.actionCalls as Record<string, unknown>[])) {
    if (!node || typeof node !== 'object') continue;
    if (node.actionType === 'apex' && typeof node.actionName === 'string') {
      refs.add('ApexClass', node.actionName);
    }
    if (node.actionType === 'flow' && typeof node.actionName === 'string') {
      refs.add('Flow', node.actionName);
    }
  }
  for (const node of asArray(flow.subflows as Record<string, unknown>[])) {
    if (node && typeof node === 'object' && typeof node.flowName === 'string') {
      refs.add('Flow', node.flowName);
    }
  }
  for (const node of asArray(flow.apexPluginCalls as Record<string, unknown>[])) {
    if (node && typeof node === 'object' && typeof node.apexClass === 'string') {
      refs.add('ApexClass', node.apexClass);
    }
  }
  // Formulas and templates can reference $Label.
  for (const m of xml.matchAll(/\$Label\.(\w+)/g)) {
    refs.add('CustomLabel', m[1]!);
  }
  return refs.list();
}

function collectFieldRefs(node: Record<string, unknown>, object: string, refs: RefSet): void {
  const fromAssignments = (key: string) => {
    for (const a of asArray(node[key] as Record<string, unknown>[])) {
      if (a && typeof a === 'object' && typeof a.field === 'string' && a.field.endsWith('__c')) {
        refs.add('CustomField', `${object}.${a.field}`);
      }
    }
  };
  fromAssignments('inputAssignments');
  fromAssignments('outputAssignments');
  fromAssignments('filters');
  const queried = node.queriedFields;
  for (const f of asArray(queried as string[])) {
    if (typeof f === 'string' && f.endsWith('__c')) refs.add('CustomField', `${object}.${f}`);
  }
}

/**
 * Extract references from an Apex body by intersecting its identifier set
 * with the known artifact names in the index — cheap, deterministic, and
 * O(body + known).
 */
export function extractApexRefs(
  body: string,
  known: KnownArtifacts,
  selfName: string,
): Ref[] {
  const refs = new RefSet();
  const source = stripApexNoise(body);
  const words = new Set(source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower === selfName.toLowerCase()) continue;
    const cls = known.classes.get(lower);
    if (cls) refs.add('ApexClass', cls);
    const obj = known.objects.get(lower);
    if (obj) refs.add('CustomObject', obj);
    // Unqualified custom-field tokens resolve when the short name is unique
    // org-wide — field-level recall without cross-object false positives.
    if (!obj && lower.endsWith('__c')) {
      const candidates = known.fieldsByShortName.get(lower);
      if (candidates?.length === 1) refs.add('CustomField', candidates[0]!);
    }
  }
  // SOQL FROM targets (also catches standard objects not in the index).
  for (const m of source.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    const obj = m[1]!;
    refs.add('CustomObject', known.objects.get(obj.toLowerCase()) ?? obj);
  }
  // Custom field tokens Object.Field__c.
  for (const m of source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]+__c)\b/g)) {
    const qualified = `${m[1]}.${m[2]}`;
    const field = known.fields.get(qualified.toLowerCase());
    if (field) refs.add('CustomField', field);
  }
  for (const m of source.matchAll(/Label\.(\w+)/g)) {
    refs.add('CustomLabel', m[1]!);
  }
  return refs.list();
}

/** Extract references from a CustomObject/CustomField/ValidationRule XML fragment or file. */
export function extractObjectXmlRefs(xml: string, objectName: string, known: KnownArtifacts): Ref[] {
  const refs = new RefSet();
  // Lookup/master-detail targets.
  for (const m of xml.matchAll(/<referenceTo>([^<]+)<\/referenceTo>/g)) {
    refs.add('CustomObject', m[1]!.trim());
  }
  // Formulas and validation rule expressions reference fields and labels.
  for (const m of xml.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*__c)\b/g)) {
    const local = known.fields.get(`${objectName}.${m[1]!}`.toLowerCase());
    if (local) refs.add('CustomField', local);
    else {
      const obj = known.objects.get(m[1]!.toLowerCase());
      if (obj) refs.add('CustomObject', obj);
    }
  }
  for (const m of xml.matchAll(/\$Label\.(\w+)/g)) {
    refs.add('CustomLabel', m[1]!);
  }
  return refs.list();
}

/**
 * Extract references from a PermissionSet XML file: object permissions,
 * field permissions, and Apex class access — the "who can touch what" edges
 * that make blast radius meaningful for security reviews.
 */
export function extractPermissionSetRefs(xml: string): Ref[] {
  const refs = new RefSet();
  let doc: Record<string, unknown>;
  try {
    doc = parseXml(xml);
  } catch {
    return [];
  }
  const ps = (doc.PermissionSet ?? {}) as Record<string, unknown>;
  for (const node of asArray(ps.objectPermissions as Record<string, unknown>[])) {
    if (node && typeof node === 'object' && typeof node.object === 'string') {
      refs.add('CustomObject', node.object);
    }
  }
  for (const node of asArray(ps.fieldPermissions as Record<string, unknown>[])) {
    if (node && typeof node === 'object' && typeof node.field === 'string') {
      refs.add('CustomField', node.field);
    }
  }
  for (const node of asArray(ps.classAccesses as Record<string, unknown>[])) {
    if (node && typeof node === 'object' && typeof node.apexClass === 'string') {
      refs.add('ApexClass', node.apexClass);
    }
  }
  return refs.list();
}

/** Case-insensitive lookup maps from the freshly indexed artifact set. */
export interface KnownArtifacts {
  classes: Map<string, string>;
  objects: Map<string, string>;
  fields: Map<string, string>;
  flows: Map<string, string>;
  /** Short field name (amount__c) → every qualified name holding it; unambiguous ones resolve Apex refs. */
  fieldsByShortName: Map<string, string[]>;
}

export function buildKnownArtifacts(
  artifacts: Array<{ type: string; apiName: string }>,
): KnownArtifacts {
  const known: KnownArtifacts = {
    classes: new Map(),
    objects: new Map(),
    fields: new Map(),
    flows: new Map(),
    fieldsByShortName: new Map(),
  };
  for (const a of artifacts) {
    const key = a.apiName.toLowerCase();
    if (a.type === 'ApexClass') known.classes.set(key, a.apiName);
    else if (a.type === 'CustomObject') known.objects.set(key, a.apiName);
    else if (a.type === 'CustomField') {
      known.fields.set(key, a.apiName);
      const short = a.apiName.split('.')[1]?.toLowerCase();
      if (short) {
        const list = known.fieldsByShortName.get(short) ?? [];
        list.push(a.apiName);
        known.fieldsByShortName.set(short, list);
      }
    } else if (a.type === 'Flow') known.flows.set(key, a.apiName);
  }
  return known;
}

/**
 * Run the full extractor over an indexed snapshot → dependency edges.
 * `known` should span the FULL artifact index, not just the slice being
 * refreshed — a partial refresh that only knew its own types would silently
 * drop cross-type edges (Apex→field, flow→object) on rebuild.
 */
export function extractAllEdges(
  connectionId: string,
  artifacts: IndexedArtifact[],
  known: KnownArtifacts = buildKnownArtifacts(artifacts),
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const add = (fromType: string, fromName: string, refs: Ref[]) => {
    for (const r of refs) {
      if (r.toType === fromType && r.toName.toLowerCase() === fromName.toLowerCase()) continue;
      edges.push({
        connectionId,
        fromType,
        fromName,
        toType: r.toType,
        toName: r.toName,
        source: 'extractor',
      });
    }
  };

  for (const a of artifacts) {
    if (a.type === 'Flow') add('Flow', a.apiName, extractFlowRefs(a.content));
    else if (a.type === 'ApexClass' || a.type === 'ApexTrigger') {
      add(a.type, a.apiName, extractApexRefs(a.content, known, a.apiName));
    } else if (a.type === 'CustomField' || a.type === 'ValidationRule') {
      const objectName = a.apiName.split('.')[0] ?? '';
      add(a.type, a.apiName, extractObjectXmlRefs(a.content, objectName, known));
    } else if (a.type === 'PermissionSet') {
      add(a.type, a.apiName, extractPermissionSetRefs(a.content));
    }
  }
  return edges;
}

/** Strip comments and string literals so their contents don't produce refs. */
function stripApexNoise(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => (/\bFROM\b/i.test(m) ? m : "''"));
}

class RefSet {
  private readonly map = new Map<string, Ref>();

  add(toType: string, toName: string): void {
    const name = toName.trim();
    if (!name) return;
    this.map.set(`${toType}:${name.toLowerCase()}`, { toType, toName: name });
  }

  list(): Ref[] {
    return [...this.map.values()];
  }
}
