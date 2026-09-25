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
  /** Set when the content was read from disk — shown to the human, audited. */
  source_path?: string;
  source_sha256?: string;
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
  /** Provenance for file-sourced components; absent when content was inline. */
  source_path?: string;
  source_sha256?: string;
}

/** File placement per deployable type (metadata format). */
interface FileSpec {
  dir: string;
  ext: string;
  metaRoot?: string;
  /** Default -meta.xml when the snapshot has none (types whose meta needs more than apiVersion+status). */
  metaXml?: (apiVersion: string, apiName: string) => string;
  /**
   * S29: folder-based analytics types. api_name is "FolderDevName/Name" —
   * exactly one '/', each segment on the tight FOLDER_SEGMENT_RE grammar
   * ('$' only for unfiled$public-style system folders). The '/' survives into
   * the zip entry path; segments are percent-encoded independently.
   */
  foldered?: true;
  /**
   * S29: the component IS its -meta.xml (report/dashboard folder definitions):
   * the file is `${dir}/${name}-meta.xml` and the proposed content is the
   * whole document (root <ReportFolder>/<DashboardFolder>, carrying the
   * folderShares that govern who can see the folder's contents).
   */
  metaOnly?: true;
  /**
   * S29: package.xml <name> when it differs from the Contrail type. Folders
   * address as members of their CONTENT type in retrieve/deploy/destructive
   * manifests (<members>Ops</members> under <name>Report</name>) — the
   * ReportFolder/DashboardFolder names exist only for listMetadata.
   */
  manifestType?: string;
  /**
   * S30: bundle types — ONE component is a DIRECTORY of files. `content` is
   * a Contrail bundle envelope: JSON `{"contrail_bundle":1, "files":
   * {"<relative path>": "<body>", …}}` whose files land under
   * `dir/<apiName>/`. package.xml gets ONE member (the bundle name).
   */
  envelope?: true;
  /**
   * The main file's name suffix inside the bundle dir (live-confirmed:
   * GenAiFunction's main XML retrieves as `<n>.genAiFunction-meta.xml`,
   * GenAiPlannerBundle's as bare `<n>.genAiPlannerBundle`). The envelope
   * MUST contain `<apiName><envelopeMainSuffix>`.
   */
  envelopeMainSuffix?: string;
}

const FILE_TYPES: Record<string, FileSpec> = {
  ApexClass: { dir: 'classes', ext: '.cls', metaRoot: 'ApexClass' },
  ApexTrigger: { dir: 'triggers', ext: '.trigger', metaRoot: 'ApexTrigger' },
  Flow: { dir: 'flows', ext: '.flow' },
  CustomObject: { dir: 'objects', ext: '.object' },
  PermissionSet: { dir: 'permissionsets', ext: '.permissionset' },
  Profile: { dir: 'profiles', ext: '.profile' },
  CustomTab: { dir: 'tabs', ext: '.tab' },
  FlowDefinition: { dir: 'flowDefinitions', ext: '.flowDefinition' },
  // S17: declarative UI / reporting types.
  FlexiPage: { dir: 'flexipages', ext: '.flexipage' },
  CustomApplication: { dir: 'applications', ext: '.app' },
  ReportType: { dir: 'reportTypes', ext: '.reportType' },
  GlobalValueSet: { dir: 'globalValueSets', ext: '.globalValueSet' },
  ApexPage: {
    dir: 'pages',
    ext: '.page',
    metaRoot: 'ApexPage',
    // ApexPage meta requires a <label> and has no <status>.
    metaXml: (v, name) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<ApexPage xmlns="${XMLNS}">\n` +
      `    <apiVersion>${escapeXml(v)}</apiVersion>\n` +
      `    <label>${escapeXml(name)}</label>\n</ApexPage>\n`,
  },
  // S17: integration / eventing types (deployable + indexable; not in the
  // default snapshot manifest — retrieve explicitly via refresh_snapshot types).
  ConnectedApp: { dir: 'connectedApps', ext: '.connectedApp' },
  NamedCredential: { dir: 'namedCredentials', ext: '.namedCredential' },
  ExternalCredential: { dir: 'externalCredentials', ext: '.externalCredential' },
  // S33: lowercase dir AND extension — unusual but live-confirmed (personal-dev
  // retrieve 2026-09-24), matching the metadata catalog.
  AuthProvider: { dir: 'authproviders', ext: '.authprovider' },
  PlatformEventChannel: { dir: 'platformEventChannels', ext: '.platformEventChannel' },
  PlatformEventChannelMember: {
    dir: 'platformEventChannelMembers',
    ext: '.platformEventChannelMember',
  },
  ManagedEventSubscription: {
    dir: 'managedEventSubscriptions',
    ext: '.managedEventSubscription',
  },
  // S19: legacy page layouts. fullName is "Object-Layout Name" — spaces,
  // parens, apostrophes are all normal ("Account-Account (Marketing) Layout").
  // Retrieve zips percent-encode such characters in FILE names (the indexer
  // decodes); deploy zips mirror that via fileSafeName, with the literal
  // fullName in package.xml members.
  Layout: { dir: 'layouts', ext: '.layout' },
  // S19: custom metadata RECORDS (the record's TYPE is a CustomObject named
  // X__mdt and deploys through the CustomObject path — one package may carry
  // the type and its records together). fullName is dotted "Type.Record"
  // with the type name WITHOUT the __mdt suffix; metadata format uses the
  // bare .md extension.
  CustomMetadata: { dir: 'customMetadata', ext: '.md' },
  // S31: lead-conversion field mappings. A SINGLETON — exactly one component
  // per org, fullName literally 'LeadConvertSettings'. The naming is the
  // platform's own quirk (live-confirmed): CAPITALIZED directory and a
  // singular '.LeadConvertSetting' extension. The component does not exist
  // until an org saves custom lead mappings (a wildcard retrieve then
  // returns nothing — harmless).
  LeadConvertSettings: { dir: 'LeadConvertSettings', ext: '.LeadConvertSetting' },
  // S29: analytics types (folder-based). EXPLICIT-REFRESH-ONLY — absent from
  // the default snapshot manifest (S17 precedent; big orgs carry thousands of
  // reports). api_name is 'FolderDevName/Name' ('unfiled$public/Name' for
  // unfiled reports). Folders deploy as members of the CONTENT type in
  // package.xml (manifestType), their file being the -meta.xml itself; a
  // report deployed into a NEW folder needs that folder in the same package.
  Report: { dir: 'reports', ext: '.report', foldered: true },
  Dashboard: { dir: 'dashboards', ext: '.dashboard', foldered: true },
  ReportFolder: { dir: 'reports', ext: '', metaOnly: true, manifestType: 'Report' },
  DashboardFolder: { dir: 'dashboards', ext: '', metaOnly: true, manifestType: 'Dashboard' },
  // S30: Agentforce types (v66+ — see the config apiVersion note). The Bot
  // document carries its versions INLINE (<botVersions>) in metadata format
  // — BotVersion deploys as a dotted-name child (see CHILD_TYPES). The two
  // deployable bundle types carry a Contrail bundle ENVELOPE as content
  // (see FileSpec.envelope). AiAuthoringBundle stays read-only permanently:
  // a plain Metadata API deploy of Agent Script silently does not apply
  // reasoning actions (only Salesforce's publish pipeline compiles them) —
  // a deploy that validates and then lies is not a deploy Contrail offers.
  Bot: { dir: 'bots', ext: '.bot' },
  GenAiFunction: {
    dir: 'genAiFunctions',
    ext: '.genAiFunction',
    envelope: true,
    envelopeMainSuffix: '.genAiFunction-meta.xml',
  },
  GenAiPlannerBundle: {
    dir: 'genAiPlannerBundles',
    ext: '.genAiPlannerBundle',
    envelope: true,
    envelopeMainSuffix: '.genAiPlannerBundle',
  },
  GenAiPlugin: { dir: 'genAiPlugins', ext: '.genAiPlugin' },
  GenAiPromptTemplate: { dir: 'genAiPromptTemplates', ext: '.genAiPromptTemplate' },
  GenAiPromptTemplateActv: {
    dir: 'genAiPromptTemplateActivations',
    ext: '.genAiPromptTemplateActivation',
  },
  AiEvaluationDefinition: { dir: 'aiEvaluationDefinitions', ext: '.aiEvaluationDefinition' },
  BotTemplate: { dir: 'botTemplates', ext: '.botTemplate' },
  BotBlock: { dir: 'botBlocks', ext: '.botBlock' },
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
  ListView: {
    containerRoot: 'CustomObject',
    dir: 'objects',
    ext: '.object',
    tag: 'listViews',
    parentFromName: (n) => n.split('.')[0] ?? '',
  },
  RecordType: {
    containerRoot: 'CustomObject',
    dir: 'objects',
    ext: '.object',
    tag: 'recordTypes',
    parentFromName: (n) => n.split('.')[0] ?? '',
  },
  // S30: bot versions are children of the Bot document (dotted MyBot.v1 —
  // the same fullName shape the Metadata API uses for standalone BotVersion
  // deploys).
  BotVersion: {
    containerRoot: 'Bot',
    dir: 'bots',
    ext: '.bot',
    tag: 'botVersions',
    parentFromName: (n) => n.split('.')[0] ?? '',
  },
};

// Parens/apostrophe/ampersand are legal in layout labels (every standard
// object ships an "Object (Marketing) Layout"); path safety stays with the
// explicit '/', '\', '..' guards in validateTypeAndName.
const NAME_RE = /^[A-Za-z0-9_.\- ()'&]+$/;
// One path segment of a foldered fullName (folder dev names and report/
// dashboard dev names: no spaces/parens; '$' exists only for the
// unfiled$public system folder). Deliberately tighter than NAME_RE — these
// names become nested filesystem paths. Depth is capped at one '/' in
// validateTypeAndName; if Lightning nested report subfolders ever surface as
// Parent/Child fullNames (unverified), the cap is the one thing to revisit.
const FOLDER_SEGMENT_RE = /^[A-Za-z0-9_$]+$/;
// S30: one segment of a bundle-envelope relative path. Dots for extensions,
// no leading dot (traversal is also rejected outright before this runs).
const BUNDLE_REL_SEGMENT_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$.\-]*$/;
const BUNDLE_MAX_FILES = 100;
const BUNDLE_MAX_DEPTH = 8;

/**
 * S30: parse and validate a Contrail bundle envelope. Security posture
 * mirrors validateTypeAndName: absolute rejects ('\\', '..') come first for
 * every path, then the tight per-segment grammar — these strings become zip
 * entry names and snapshot paths.
 */
export function parseBundleEnvelope(
  type: string,
  apiName: string,
  content: string,
  mainFile: string,
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ContrailError(
      `${type} ${apiName}: content must be a Contrail bundle envelope — JSON of the shape ` +
        `{"contrail_bundle":1, "files": {"${mainFile}": "<xml>", "input/schema.json": "…"}}. ` +
        `Bundle types are directories of files; retrieve_metadata's bundle_files listing ` +
        `shows the real file set to carry over.`,
      'bad_component',
    );
  }
  const env = parsed as { contrail_bundle?: unknown; files?: unknown };
  if (env.contrail_bundle !== 1 || typeof env.files !== 'object' || env.files === null) {
    throw new ContrailError(
      `${type} ${apiName}: envelope must carry contrail_bundle: 1 and a files object.`,
      'bad_component',
    );
  }
  const files = env.files as Record<string, unknown>;
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > BUNDLE_MAX_FILES) {
    throw new ContrailError(
      `${type} ${apiName}: envelope carries ${entries.length} files (1–${BUNDLE_MAX_FILES} allowed).`,
      'bad_component',
    );
  }
  const out: Record<string, string> = {};
  for (const [rel, body] of entries) {
    if (rel.includes('\\') || rel.includes('..')) {
      throw new ContrailError(
        `${type} ${apiName}: invalid envelope path "${rel}"`,
        'bad_component',
      );
    }
    const segs = rel.split('/');
    if (
      segs.length === 0 ||
      segs.length > BUNDLE_MAX_DEPTH ||
      segs.some((s) => !BUNDLE_REL_SEGMENT_RE.test(s))
    ) {
      throw new ContrailError(
        `${type} ${apiName}: invalid envelope path "${rel}"`,
        'bad_component',
      );
    }
    if (typeof body !== 'string') {
      throw new ContrailError(
        `${type} ${apiName}: envelope file "${rel}" must be a string body.`,
        'bad_component',
      );
    }
    out[rel] = body;
  }
  if (!(mainFile in out)) {
    throw new ContrailError(
      `${type} ${apiName}: envelope is missing its main file "${mainFile}".`,
      'bad_component',
    );
  }
  return out;
}
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
    if (fileSpec?.envelope) {
      const mainFile = `${c.api_name}${fileSpec.envelopeMainSuffix ?? fileSpec.ext}`;
      const bundleFiles = parseBundleEnvelope(c.type, c.api_name, c.content, mainFile);
      const dirPrefix = `${fileSpec.dir}/${fileSafeSegment(c.api_name)}/`;
      for (const [rel, body] of Object.entries(bundleFiles)) {
        files.set(`${dirPrefix}${rel}`, strToU8(body));
      }
      addMember(fileSpec.manifestType ?? c.type, c.api_name);
      continue;
    }
    if (fileSpec) {
      // A stray envelope aimed at a non-envelope type would deploy the JSON
      // verbatim as the component body — fail locally with the honest error.
      if (/^\s*\{\s*"contrail_bundle"/.test(c.content)) {
        throw new ContrailError(
          `${c.type} ${c.api_name}: a Contrail bundle envelope was passed but ${c.type} is a ` +
            `single-file type — pass the document itself as content.`,
          'bad_component',
        );
      }
      const path = zipPathFor(fileSpec, c.api_name);
      files.set(path, strToU8(c.content));
      if (fileSpec.metaRoot) {
        const meta =
          metaXmlLookup(c.type, c.api_name) ??
          fileSpec.metaXml?.(apiVersionNumber, c.api_name) ??
          `<?xml version="1.0" encoding="UTF-8"?>\n<${fileSpec.metaRoot} xmlns="${XMLNS}">\n` +
            `    <apiVersion>${escapeXml(apiVersionNumber)}</apiVersion>\n` +
            `    <status>Active</status>\n</${fileSpec.metaRoot}>\n`;
        files.set(`${path}-meta.xml`, strToU8(meta));
      }
      addMember(fileSpec.manifestType ?? c.type, c.api_name);
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

  // Deletions are deliberately NOT gated by the deployable-type allowlist:
  // destructiveChanges needs only a manifest entry, every deletion is
  // approval-gated and destructive-prominent, and removing types Contrail
  // cannot author (stray-metadata cleanup) is a feature. Name/type syntax is
  // still validated. Pinned by test — do not "fix" this into the FILE_TYPES
  // gate.
  for (const d of deletions) {
    validateTypeAndName(d.type, d.api_name);
  }

  const packageXml = manifestXml(members, apiVersionNumber, 'Package');
  files.set('package.xml', strToU8(packageXml));

  let destructiveXml: string | null = null;
  if (deletions.length > 0) {
    const delMembers = new Map<string, string[]>();
    for (const d of deletions) {
      // Folder components delete as members of their content type too
      // (deleting ReportFolder:Ops emits <members>Ops</members> under
      // <name>Report</name>); unknown types keep the ungated literal path.
      const manifestType = FILE_TYPES[d.type]?.manifestType ?? d.type;
      const list = delMembers.get(manifestType) ?? [];
      list.push(d.api_name);
      delMembers.set(manifestType, list);
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

/**
 * Zip entry names mirror what retrieve produces: characters outside the
 * filename-safe set (parens and friends) are percent-encoded, while the
 * package.xml <members> keeps the literal fullName — that pairing is how the
 * Metadata API matches a member to its file.
 */
export function fileSafeName(name: string): string {
  return name.replace(/[^A-Za-z0-9 _.\-]/g, (ch) =>
    Array.from(new TextEncoder().encode(ch))
      .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join(''),
  );
}

/**
 * S29: one segment of a foldered path. Like fileSafeName but keeps '$'
 * literal — retrieve zips carry unfiled$public unencoded, and the pairing
 * with package.xml members is what the Metadata API matches on.
 */
function fileSafeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9 _.\-$]/g, (ch) =>
    Array.from(new TextEncoder().encode(ch))
      .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join(''),
  );
}

/**
 * Zip entry path for a FILE_TYPES component. The ONE naming authority shared
 * by buildDeployZip and deployZipEntryPath, so the builder and the S28
 * manifest-capture reader cannot drift. Foldered names keep their '/' with
 * each segment encoded independently; metaOnly components (folder
 * definitions) ARE their -meta.xml.
 */
function zipPathFor(spec: FileSpec, apiName: string): string {
  if (spec.metaOnly) return `${spec.dir}/${fileSafeSegment(apiName)}-meta.xml`;
  const name = spec.foldered
    ? apiName.split('/').map(fileSafeSegment).join('/')
    : fileSafeName(apiName);
  return `${spec.dir}/${name}${spec.ext}`;
}

/**
 * Where a component's content lives inside a deploy zip built by
 * buildDeployZip — the ONE place that knows the naming (S28 manifest capture
 * reads deployed bytes back out of the frozen zip through this, so a
 * reimplementation drifting from the builder would silently capture nothing).
 * Child types have no entry of their own: they return the PARENT document's
 * path plus the tag/name coordinates for a findChildBlock-style extraction.
 */
export function deployZipEntryPath(
  type: string,
  apiName: string,
):
  | { path: string; child: false; bundleDir?: string }
  | { path: string; child: true; childTag: string; childName: string }
  | null {
  const childSpec = CHILD_TYPES[type];
  if (childSpec) {
    const parent = childSpec.parentFromName(apiName);
    if (!parent) return null;
    return {
      path: `${childSpec.dir}/${fileSafeName(parent)}${childSpec.ext}`,
      child: true,
      childTag: childSpec.tag,
      childName: apiName.includes('.') ? apiName.slice(apiName.indexOf('.') + 1) : apiName,
    };
  }
  const spec = FILE_TYPES[type];
  if (!spec) return null;
  if (spec.envelope) {
    // S30 bundle: path = the main file; bundleDir = the whole component's
    // prefix, so the S28 capture reader can gather EVERY entry.
    const dirPrefix = `${spec.dir}/${fileSafeSegment(apiName)}/`;
    return {
      path: `${dirPrefix}${apiName}${spec.envelopeMainSuffix ?? spec.ext}`,
      child: false,
      bundleDir: dirPrefix,
    };
  }
  return { path: zipPathFor(spec, apiName), child: false };
}

function validateTypeAndName(type: string, name: string): void {
  if (!/^[A-Za-z]+$/.test(type)) throw new ContrailError(`invalid type "${type}"`, 'bad_component');
  // Absolute rejects come FIRST for every name shape — defense in depth on
  // values that become filesystem paths and zip entry names. Pinned by test.
  if (name.includes('\\') || name.includes('..')) {
    throw new ContrailError(`invalid component name "${name}"`, 'bad_component');
  }
  const spec = FILE_TYPES[type];
  if (spec?.foldered) {
    // Exactly one '/', both segments tight — leading/trailing/double slashes
    // and traversal are unrepresentable in this grammar.
    const segs = name.split('/');
    if (segs.length !== 2 || segs.some((s) => !FOLDER_SEGMENT_RE.test(s))) {
      throw new ContrailError(
        `invalid ${type} name "${name}" — expected "FolderDevName/Name" (letters, digits, underscores)`,
        'bad_component',
      );
    }
    return;
  }
  if (spec?.metaOnly) {
    // Folder components: a single folder dev-name segment, no slash.
    if (!FOLDER_SEGMENT_RE.test(name)) {
      throw new ContrailError(
        `invalid ${type} name "${name}" — a folder dev name (letters, digits, underscores)`,
        'bad_component',
      );
    }
    return;
  }
  if (!NAME_RE.test(name) || name.includes('/')) {
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
        ...sourceOf(c),
      });
      continue;
    }
    // S30 envelope bundles classify file-by-file against the snapshot
    // directory — the proposed content is an envelope, not a document.
    const envSpec = FILE_TYPES[c.type];
    if (envSpec?.envelope) {
      const mainFile = `${c.api_name}${envSpec.envelopeMainSuffix ?? envSpec.ext}`;
      const proposed = parseBundleEnvelope(c.type, c.api_name, c.content, mainFile);
      const existingBundle = db.getArtifact(conn.id, c.type, c.api_name);
      const warnings: string[] = [];
      let change: ComponentChange['change'];
      if (!existingBundle) {
        change = 'add';
      } else {
        const old = readBundleFiles(store, conn, envSpec.dir, c.api_name);
        const added = Object.keys(proposed).filter((k) => !(k in old));
        const removed = Object.keys(old).filter((k) => !(k in proposed));
        const changed = Object.keys(proposed).filter(
          (k) => k in old && old[k]!.trim() !== proposed[k]!.trim(),
        );
        change =
          added.length + removed.length + changed.length === 0 ? 'unchanged_content' : 'modify';
        if (change === 'modify') {
          const describe = (label: string, list: string[]) =>
            list.length > 0 ? `${label} ${list.slice(0, 8).join(', ')}${list.length > 8 ? '…' : ''}` : '';
          const delta = [
            describe('changed:', changed),
            describe('added:', added),
            describe('removed:', removed),
          ]
            .filter(Boolean)
            .join('; ');
          warnings.push(
            `BUNDLE REPLACE — this deploy replaces the org's whole ${c.type} directory ` +
              `(${Object.keys(proposed).length} files; ${delta}).`,
          );
        }
      }
      if (c.type === 'GenAiPlannerBundle' && change === 'modify') {
        warnings.push(
          `AGENT MUST BE DEACTIVATED FIRST — deploying GenAiPlannerBundle changes for an ` +
            `ACTIVE agent version fails, and version-suffixed bundles are PUBLISHED ` +
            `SNAPSHOTS: a modified deploy of one fails org-side even deactivated ` +
            `(unmodified re-deploys "succeed" as no-ops). Deactivate in Agent Builder, ` +
            `deploy, then reactivate (Contrail cannot do those steps; verify with ` +
            `BotVersion.Status). On Agent-Script agents the next publish overwrites ` +
            `hand-edits.`,
        );
      }
      changes.push({ type: c.type, api_name: c.api_name, change, warnings, ...sourceOf(c) });
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
      // Full-document UI types replace, never merge: an element missing from
      // the proposed content is REMOVED from the org's definition.
      if (
        (c.type === 'FlexiPage' ||
          c.type === 'CustomApplication' ||
          c.type === 'Layout' ||
          c.type === 'Report' ||
          c.type === 'Dashboard' ||
          c.type === 'GenAiPlugin' ||
          c.type === 'GenAiPromptTemplate' ||
          c.type === 'Bot' ||
          c.type === 'LeadConvertSettings' ||
          c.type === 'NamedCredential' ||
          c.type === 'ExternalCredential' ||
          c.type === 'AuthProvider') &&
        change === 'modify'
      ) {
        warnings.push(
          `WHOLE-DOCUMENT REPLACE — this deploy fully replaces the org's ${c.type}; ` +
            `anything not present in the proposed content is removed.` +
            (c.type === 'Bot'
              ? ' A <botVersions> block omitted from a Bot document is a VERSION DELETE.'
              : c.type === 'LeadConvertSettings'
                ? ' An <objectMapping> omitted here is a lead field mapping DELETED org-wide.'
                : c.type === 'ExternalCredential'
                  ? ' A principal parameter omitted here is DELETED org-side — along with the' +
                    ' credential values a human entered for it in Setup.'
                  : ''),
        );
      }
      // S30: the activeVersionIdentifier is an org-generated token. Altering
      // it by hand mis-targets (or fails) the active-version pointer — the
      // doctrine is retrieve-first, then modify the retrieved copy.
      if (c.type === 'GenAiPromptTemplate' && change === 'modify') {
        const oldId = oldContent?.match(/<activeVersionIdentifier>([^<]*)</)?.[1];
        const newId = c.content.match(/<activeVersionIdentifier>([^<]*)</)?.[1];
        if (oldId && newId && oldId !== newId) {
          warnings.push(
            `activeVersionIdentifier ALTERED (${oldId.slice(0, 12)}… → ${newId.slice(0, 12)}…) — ` +
              `these tokens are org-generated; a hand-edited value is rejected or mis-targets ` +
              `the active version. To activate a new version, retrieve after deploying it and ` +
              `repoint using the versionIdentifier the org minted.`,
          );
        }
      }
      // Folder definitions replace their sharing wholesale: the folderShares
      // in this content ARE the folder's sharing after the deploy.
      if ((c.type === 'ReportFolder' || c.type === 'DashboardFolder') && change === 'modify') {
        warnings.push(
          `FOLDER REPLACE — the folderShares in this content fully replace the ` +
            `folder's sharing; shares omitted here are revoked.`,
        );
      }
      // Custom metadata records deploy as full replacements too: a field with
      // no <values> entry in this content is reset on the org's record.
      if (c.type === 'CustomMetadata' && change === 'modify') {
        warnings.push(
          `FULL-RECORD REPLACE — fields omitted from this content are reset to ` +
            `null/default on the deployed record.`,
        );
      }
    }
    // A layout deploy never assigns the layout: assignment lives in Profile
    // metadata (layoutAssignments) or Setup. Say so for NEW layouts, which
    // otherwise deploy and then sit unused.
    if (c.type === 'Layout' && change === 'add') {
      warnings.push(
        `NEW LAYOUT IS NOT ASSIGNED by this deploy — profiles keep their current ` +
          `layout until layoutAssignments change (Profile metadata or Setup).`,
      );
    }
    // Report/dashboard access is FOLDER sharing, not permission sets — no
    // permission-coverage arm can exist for these (see the note in
    // analyzePermissionCoverage), so the honesty lives here instead.
    if ((c.type === 'Report' || c.type === 'Dashboard') && change === 'add') {
      warnings.push(
        `NEW ${c.type.toUpperCase()} visibility is governed by its FOLDER's sharing ` +
          `(folderShares on the folder component), not by permission sets — this ` +
          `deploy grants nobody new access by itself.`,
      );
    }
    // S30: a NET-NEW prompt template carrying a hand-typed identifier cannot
    // be right — the org mints these tokens on deploy.
    if (
      c.type === 'GenAiPromptTemplate' &&
      change === 'add' &&
      /<activeVersionIdentifier>[^<]/.test(c.content)
    ) {
      warnings.push(
        `activeVersionIdentifier on a NET-NEW template — this token is org-generated and ` +
          `cannot be authored from scratch. Omit it (the org mints one on deploy), or ` +
          `retrieve-first if this template already exists under another name.`,
      );
    }
    // S30: the deactivate gate. Topic/action/instruction changes against an
    // ACTIVE agent version fail org-side — the human deactivates in Agent
    // Builder first, then reactivates after the deploy. Contrail has no
    // activate/deactivate path (that lifecycle is org-side, not Metadata
    // API); check state with soql_query on BotVersion.Status. (The
    // GenAiPlannerBundle flavor of this warning lives in the envelope
    // branch above.)
    if (c.type === 'GenAiPlugin' && change === 'modify') {
      warnings.push(
        `AGENT MUST BE DEACTIVATED FIRST — deploying ${c.type} changes for an ACTIVE ` +
          `agent version fails. Deactivate the agent in Agent Builder, deploy, then ` +
          `reactivate (Contrail cannot do those steps; verify with BotVersion.Status).`,
      );
    }
    // S33: a NEW external credential defines principals but carries NO secret
    // values and grants NO access — both of those are post-deploy steps, and
    // silence here would let "deployed" read as "working".
    if (c.type === 'ExternalCredential' && change === 'add') {
      warnings.push(
        `NEW EXTERNAL CREDENTIAL carries no secrets and grants nobody access — a human ` +
          `enters each principal's credential values in Setup (External Credentials) after ` +
          `the deploy, and callouts fail until a permission set grants ` +
          `externalCredentialPrincipalAccesses for its principals.`,
      );
    }
    // S33: literal secrets in deploy content. Modern credential metadata never
    // carries secret values (they live in Setup, per principal) — but the
    // LEGACY NamedCredential fields and AuthProvider.consumerSecret accept
    // them, and a deployed secret lands in the local snapshot, the audit
    // trail, and this approval page, while retrieves return placeholders so
    // the value never round-trips.
    {
      const secretTags =
        c.type === 'NamedCredential'
          ? ['password', 'awsAccessSecret', 'oauthToken', 'oauthRefreshToken']
          : c.type === 'AuthProvider'
            ? ['consumerSecret']
            : [];
      for (const tag of secretTags) {
        if (new RegExp(`<${tag}>[^<]`).test(c.content)) {
          warnings.push(
            `LITERAL SECRET IN DEPLOY CONTENT (<${tag}>) — this value becomes part of the ` +
              `local snapshot, the audit trail, and this approval page, and a retrieve ` +
              `returns only a placeholder (it will not round-trip). Prefer External ` +
              `Credentials, where secrets are entered in Setup and never touch metadata.`,
          );
        }
      }
    }
    changes.push({ type: c.type, api_name: c.api_name, change, warnings, ...sourceOf(c) });
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

/** Provenance fields, present only when the component was read from a file. */
function sourceOf(c: ProposedComponent): { source_path?: string; source_sha256?: string } {
  return c.source_path
    ? { source_path: c.source_path, source_sha256: c.source_sha256 }
    : {};
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
  kind: 'field' | 'object' | 'class' | 'tab' | 'page' | 'application' | 'agent' | 'credentialPrincipal';
}

/**
 * S33: principals defined by an ExternalCredential — externalCredentialParameters
 * whose parameterType is NamedPrincipal or PerUserPrincipal; the principal's
 * name is its parameterName (live-confirmed grammar). Permission sets grant
 * them as `<ExternalCredentialDevName>-<principalName>` (dash-joined, e.g.
 * "Mulesoft-Basic" — live-confirmed from a real org's permission set).
 */
function externalCredentialPrincipals(xml: string): string[] {
  const names: string[] = [];
  for (const block of xml.match(/<externalCredentialParameters>[\s\S]*?<\/externalCredentialParameters>/g) ?? []) {
    const type = block.match(/<parameterType>\s*([^<]+?)\s*<\/parameterType>/)?.[1] ?? '';
    if (!/^(NamedPrincipal|PerUserPrincipal)$/i.test(type)) continue;
    const name = block.match(/<parameterName>\s*([^<]+?)\s*<\/parameterName>/)?.[1];
    if (name) names.push(name);
  }
  return names;
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
    case 'page':
      return permissionBlocks(containerText, 'pageAccesses').some(
        (b) => named(b, 'apexPage', need.api_name) && flagOn(b, 'enabled'),
      );
    case 'application':
      return permissionBlocks(containerText, 'applicationVisibilities').some(
        (b) => named(b, 'application', need.api_name) && flagOn(b, 'visible'),
      );
    case 'agent':
      // S30: agent access is a REAL PermissionSet block (contrast the
      // Report/Dashboard folder-sharing absence below).
      return permissionBlocks(containerText, 'agentAccesses').some(
        (b) => named(b, 'agentName', need.api_name) && flagOn(b, 'enabled'),
      );
    case 'credentialPrincipal':
      // S33: external credential principals are granted by name
      // "<ExtCredDevName>-<principalName>" in a real PermissionSet block.
      return permissionBlocks(containerText, 'externalCredentialPrincipalAccesses').some(
        (b) => named(b, 'externalCredentialPrincipal', need.api_name) && flagOn(b, 'enabled'),
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
 *
 * Deliberately NO arm for Report/Dashboard: their access is folder sharing
 * (folderShares on the folder component), which no PermissionSet grants — an
 * arm here would flag every report deploy as uncovered with advice the human
 * cannot act on. The folder-sharing honesty warning lives in analyzeChanges.
 */
export function analyzePermissionCoverage(components: ProposedComponent[]): PermissionCoverage {
  const containers = components.filter((c) => c.type === 'PermissionSet' || c.type === 'Profile');
  const hasContainer = containers.length > 0;
  const containerText = containers.map((c) => c.content).join('\n');

  const needs: PermissionNeed[] = [];
  for (const c of components) {
    if (c.type === 'CustomField') {
      // __mdt parents excepted: custom metadata type fields have no FLS.
      if (!/__mdt\./i.test(c.api_name)) {
        needs.push({ type: 'CustomField', api_name: c.api_name, permission: 'field-level security (FLS)', kind: 'field' });
      }
    } else if (c.type === 'ApexClass') {
      needs.push({ type: 'ApexClass', api_name: c.api_name, permission: 'Apex class access', kind: 'class' });
    } else if (c.type === 'CustomTab') {
      needs.push({ type: 'CustomTab', api_name: c.api_name, permission: 'tab visibility', kind: 'tab' });
    } else if (c.type === 'ApexPage') {
      needs.push({ type: 'ApexPage', api_name: c.api_name, permission: 'Visualforce page access', kind: 'page' });
    } else if (c.type === 'CustomApplication') {
      needs.push({ type: 'CustomApplication', api_name: c.api_name, permission: 'app visibility', kind: 'application' });
    } else if (c.type === 'Bot') {
      // S30: users reach an agent through agentAccesses on a permission set.
      needs.push({ type: 'Bot', api_name: c.api_name, permission: 'agent access (agentAccesses)', kind: 'agent' });
    } else if (c.type === 'ExternalCredential') {
      // S33: every principal an external credential defines needs an
      // externalCredentialPrincipalAccesses grant before anyone's callouts
      // work. Deliberately NO arm for NamedCredential (access rides the
      // external credential's principals; legacy NCs have no permission-set
      // grant at all) or AuthProvider (no permission-set block exists).
      for (const principal of externalCredentialPrincipals(c.content)) {
        needs.push({
          type: 'ExternalCredential',
          api_name: `${c.api_name}-${principal}`,
          permission: 'external credential principal access (externalCredentialPrincipalAccesses)',
          kind: 'credentialPrincipal',
        });
      }
    } else if (c.type === 'CustomObject') {
      if (isCustomEntity(c.api_name)) {
        needs.push({ type: 'CustomObject', api_name: c.api_name, permission: 'object permissions', kind: 'object' });
      }
      // Custom metadata type fields have NO field-level security — flagging
      // them would demand a fieldPermissions grant Salesforce rejects.
      if (/__mdt$/i.test(c.api_name)) continue;
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

/**
 * S30: the snapshot's view of a bundle, keyed by path RELATIVE to the bundle
 * directory — the same key shape a Contrail bundle envelope uses, so the
 * change classifier compares like with like.
 */
function readBundleFiles(
  store: SnapshotStore,
  conn: ConnectionRecord,
  dir: string,
  apiName: string,
): Record<string, string> {
  const prefix = `${dir}/${fileSafeSegment(apiName)}/`;
  const out: Record<string, string> = {};
  for (const rel of store.listCurrentFiles(conn.id, prefix)) {
    const body = store.readCurrentFile(conn.id, rel);
    if (body !== null) out[rel.slice(prefix.length)] = body;
  }
  return out;
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
