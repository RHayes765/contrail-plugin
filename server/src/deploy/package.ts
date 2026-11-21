import { strToU8, zipSync } from 'fflate';
import {
  escapeXml,
  withoutXmlBlocks,
  xmlBlocks,
  xmlTagTexts,
  xmlTagValue,
} from '../salesforce/xml.js';
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
  /**
   * S45: what the org held for this member when validate_deploy ran — the
   * live baseline the approval page diffs against and the execute-time
   * "target moved" check compares last-modified stamps with. Absent on dry
   * runs and whenever the live check never ran.
   */
  pre_image?: ComponentPreImage;
}

/** S46 D1: where a member's last-modified stamp is read from. */
export type StampSource =
  | 'listMetadata'
  | 'tooling:CustomField'
  | 'tooling:ValidationRule'
  | 'tooling:ExternalString'
  | 'data:ListView';

/**
 * S45: the frozen summary of one member's live pre-image (the bytes
 * themselves live on disk under staging/_reverts/, never here). `present` is
 * null when the org could not enumerate the type at all, or when no read
 * named the member (its name cannot be placed); `source` says
 * whether the member's bytes were retrieved or only the listing was
 * consulted; `comparable` is false when a diff against the retrieved bytes
 * would lie (Profile — a single-member retrieve is package-relative — and
 * list-only members); `restorable` is false when no bytes were captured for
 * a revert. Dates are null when the org's listing did not describe the
 * member (a type in dates_unavailable_types).
 */
export interface ComponentPreImage {
  present: boolean | null;
  source: 'retrieve' | 'list';
  /** S46 D1: the source this member's stamp was read from at validate (or would have been —
   *  the dates are null when it returned no usable stamp, failed, or cannot name this member, such
   *  as a standard field). Absent = validated by 0.39: listMetadata. */
  stamp_source?: StampSource;
  sha256?: string;
  last_modified_date: string | null;
  last_modified_by: string | null;
  comparable: boolean;
  restorable: boolean;
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
   * MUST contain `<apiName><envelopeMainSuffix>`. S41: an ARRAY means the
   * bundle's kind is caller-chosen — the envelope must contain EXACTLY ONE
   * of the candidates (Aura: .cmp|.app|.evt|.intf|.tokens).
   */
  envelopeMainSuffix?: string | string[];
  /**
   * S41: the main file's own `-meta.xml` is REQUIRED on deploy. Expressed
   * separately from requiredSuffixes because the meta's NAME depends on
   * which main file was found (`voiceCallPop.cmp-meta.xml`). The platform
   * itself tolerates its absence (old bundles retrieve without one);
   * Contrail requires it on deploy to pin apiVersion explicitly.
   */
  requireMainMeta?: true;
  /**
   * S41: the bundle is FLAT — no subfolders in envelope paths (Aura).
   * Bundle types without this keep BUNDLE_MAX_DEPTH subfolders (LWC
   * templates/ is real, live-confirmed in S36).
   */
  flat?: true;
  /**
   * S34: additional files `<apiName><suffix>` the envelope MUST also carry
   * beyond the main file (AiAuthoringBundle's `.bundle-meta.xml` is real
   * required content, not generated). No upper cap on extras — the org is
   * the authority there, and the approval page lists every file anyway.
   */
  requiredSuffixes?: string[];
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
  // S33: lowercase dir AND extension — unusual but live-confirmed (a dev org
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
  // — BotVersion deploys as a dotted-name child (see CHILD_TYPES). The
  // deployable bundle types carry a Contrail bundle ENVELOPE as content
  // (see FileSpec.envelope).
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
  // S44: the Agentforce Studio Tests-tab suite and its companion custom-
  // scorer type. AiTestingDefinition is BETA per Salesforce (the type AND
  // its runner); AiAgentScorerDefinition is documented (Agentforce dev
  // guide). Both dir/suffix pairs live-confirmed via describeMetadata
  // 2026-11-08 at v66 and v68: neither inFolder, neither metaFile, no
  // children — plain single-file documents, no meta sidecar, no
  // permission-set block (analyzePermissionCoverage says so). Scorer
  // VERSIONS are documented append-only org-side — the analyzeChanges arm
  // carries that honesty — and when a GenAiPromptTemplate a scorer engines
  // on ships in the same package, MANIFEST_TYPE_AFTER lists the template's
  // <types> block first (the one documented order-sensitive pair).
  AiTestingDefinition: { dir: 'aiTestingDefinitions', ext: '.aiTestingDefinition' },
  AiAgentScorerDefinition: {
    dir: 'aiAgentScorerDefinitions',
    ext: '.aiAgentScorerDefinition',
  },
  BotTemplate: { dir: 'botTemplates', ext: '.botTemplate' },
  BotBlock: { dir: 'botBlocks', ext: '.botBlock' },
  // S34: Agent Script deploys as a DRAFT STAGE (reversing S30's read-only
  // stance, which guarded against a real lie — pretending a deploy compiles.
  // It never does, at any API version: a no-<target> deploy lands the script
  // as a DRAFT in Agentforce Studio, documented and runtime-inert, and the
  // D1 warning in analyzeChanges says exactly that on every approval page.
  // Compiling/publishing stays human — Studio or Salesforce's Agentforce DX
  // publish command; the undocumented publish endpoints are a permanent
  // non-goal). Exactly two files, live-confirmed: <Name>.agent (PLAINTEXT
  // Agent Script) + <Name>.bundle-meta.xml.
  AiAuthoringBundle: {
    dir: 'aiAuthoringBundles',
    ext: '.agent',
    envelope: true,
    envelopeMainSuffix: '.agent',
    requiredSuffixes: ['.bundle-meta.xml'],
  },
  // S36: permissions & UI-action types. CustomPermission pairs with a
  // permission set's customPermissions block (coverage arm below).
  CustomPermission: { dir: 'customPermissions', ext: '.customPermission' },
  // S36: permission set groups recalculate ASYNCHRONOUSLY after deploy
  // (Status Updating → Updated — retrieves carry <status>, live-confirmed);
  // the analyzeChanges arms say so on every approval page. Dir casing
  // live-confirmed all-lowercase (S33 authproviders precedent held).
  PermissionSetGroup: { dir: 'permissionsetgroups', ext: '.permissionsetgroup' },
  MutingPermissionSet: { dir: 'mutingpermissionsets', ext: '.mutingpermissionset' },
  // S36: quick actions. Object-scoped actions have DOTTED fullNames
  // ("Account.New_X") that are NOT parent.child fragments — QuickAction is a
  // plain top-level type (CustomMetadata precedent): NAME_RE admits the dot,
  // fileSafeName keeps it literal, and the retrieve file is the literal
  // "quickActions/Account.New_X.quickAction" (live-confirmed). Global
  // actions are undotted. '*' retrieves BOTH shapes (live-confirmed).
  QuickAction: { dir: 'quickActions', ext: '.quickAction' },
  // S36: Lightning web components. A bundle: <n>.js (main) + <n>.js-meta.xml
  // (required — carries isExposed/targets) + optional .html/.css/.svg and
  // subdirectories (secondary templates like templates/x.html are real,
  // live-confirmed). JS-only service components are normal (no .html).
  LightningComponentBundle: {
    dir: 'lwc',
    ext: '.js',
    envelope: true,
    envelopeMainSuffix: '.js',
    requiredSuffixes: ['.js-meta.xml'],
  },
  // S41: Aura component bundles. FLAT directories (live-confirmed on a
  // real partial-org retrieve, 2026-11-04: every file `<N>`-prefixed, no
  // subfolders); exactly ONE primary per bundle (.cmp component, .app
  // application, .evt event, .intf interface, .tokens tokens); the primary's
  // own -meta.xml is required on deploy (pins apiVersion — Developer Console
  // creates bundles at the org's CURRENT version otherwise) and tolerated
  // absent on retrieve. Deploy names are namespace-free developer names; the
  // index/read path also serves ns__Name bundles (read-only). The deploy
  // REPLACES the whole bundle: a file the org has that the envelope omits is
  // deleted (SDR supportsPartialDelete; the BUNDLE REPLACE arm says so).
  AuraDefinitionBundle: {
    dir: 'aura',
    ext: '.cmp',
    envelope: true,
    envelopeMainSuffix: ['.cmp', '.app', '.evt', '.intf', '.tokens'],
    requireMainMeta: true,
    flat: true,
  },
  // S47: Omnistudio Data Mappers. describeMetadata at v68 (2026-11-20):
  // directory omniDataTransforms, suffix rpt, inFolder=false,
  // metaFile=false, no child types — a plain single-file document, no meta
  // sidecar, no envelope. The Industries developer-guide page's
  // .omniDataTransform suffix is wrong (describe and Salesforce's CLI
  // registry both say rpt). Per Salesforce Help the Metadata API deploys
  // these only where the org's Omnistudio Metadata setting is on; the
  // analyzeChanges arms say so on every approval page. Explicit-refresh-only.
  OmniDataTransform: { dir: 'omniDataTransforms', ext: '.rpt' },
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

/**
 * A type's row in a type table (FILE_TYPES, CHILD_TYPES) — an OWN property
 * only. A type name arrives from the package as any run of letters, and
 * "constructor", "toString" or "hasOwnProperty" must not find an inherited
 * Object.prototype member and pass for a registered type: such a type is
 * simply unregistered.
 */
function typeEntry<T>(table: Record<string, T>, type: string): T | undefined {
  return Object.hasOwn(table, type) ? table[type] : undefined;
}

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
 * S41: the Aura bundle grammar — flat, every key `<N>`-prefixed, one meta
 * (named after the primary), secondaries by bundle kind. Live-confirmed
 * against real org retrieves (2026-11-04). Each refusal
 * names its own reason: a generic "invalid path" for a Provider.js would
 * send the author hunting through the wrong rules.
 */
const AURA_SECONDARIES: Record<string, string[]> = {
  '.cmp': ['Controller.js', 'Helper.js', 'Renderer.js', '.css', '.design', '.svg', '.auradoc'],
  '.app': ['Controller.js', 'Helper.js', 'Renderer.js', '.css', '.svg', '.auradoc'],
  '.evt': ['.auradoc'],
  '.intf': ['.auradoc'],
  '.tokens': [],
};
const AURA_MAX_FILE_BYTES = 1_000_000;

/**
 * S41: Tooling AuraDefinition.DefType → bundle file-name suffix
 * (live-confirmed table; the read path and the live validate checks share
 * it). AuraDefinition has NO meta DefType — the meta file is rebuilt from
 * AuraDefinitionBundle.ApiVersion/Description where needed. Never read
 * AuraDefinitionBundle.Metadata instead: it returned a controller cut at
 * 255 bytes (live-confirmed).
 */
export const AURA_DEFTYPE_FILES: Record<string, string> = {
  APPLICATION: '.app',
  COMPONENT: '.cmp',
  EVENT: '.evt',
  INTERFACE: '.intf',
  TOKENS: '.tokens',
  CONTROLLER: 'Controller.js',
  HELPER: 'Helper.js',
  RENDERER: 'Renderer.js',
  STYLE: '.css',
  DESIGN: '.design',
  SVG: '.svg',
  DOCUMENTATION: '.auradoc',
};

/**
 * S41 (§3.15): can Contrail READ this type — and so list its dependents,
 * classify the change, show content? The destructive path deliberately
 * accepts ANY type (cleanup is a feature); this predicate decides whether a
 * delete gets type-aware arms or the UNREGISTERED TYPE DELETE treatment.
 */
export function isRegisteredType(type: string): boolean {
  return Object.hasOwn(FILE_TYPES, type) || Object.hasOwn(CHILD_TYPES, type);
}

/**
 * S45: the retrieve manifest entry that fetches ONE component's live bytes —
 * mirrors the component arms of buildDeployZip (bundle, file, child) so the
 * pre-image retrieve names exactly what the deploy will write: children come
 * down inside their container document (CustomObject / CustomLabels / Bot,
 * addressed by the parent name) and folder components as members of their
 * CONTENT type (manifestType). null for a type Contrail cannot author: the
 * destructive path admits any literal type name, but with no directory map
 * there is no zip entry to read, so such a member gets a list-only pre-image.
 */
export function retrieveMemberFor(
  type: string,
  apiName: string,
): { type: string; member: string } | null {
  const fileSpec = typeEntry(FILE_TYPES, type);
  if (fileSpec) return { type: fileSpec.manifestType ?? type, member: apiName };
  const childSpec = typeEntry(CHILD_TYPES, type);
  if (childSpec) {
    const parent = childSpec.parentFromName(apiName);
    return parent ? { type: childSpec.containerRoot, member: parent } : null;
  }
  return null;
}

/** S41: parse a bundle envelope by TYPE (spec looked up internally) — for callers outside this file. */
export function parseEnvelopeFor(
  type: string,
  apiName: string,
  content: string,
): { files: Record<string, string>; main: string } {
  const spec = typeEntry(FILE_TYPES, type);
  if (!spec?.envelope) {
    throw new ContrailError(`${type} is not a bundle (envelope) type`, 'bad_component');
  }
  return parseBundleEnvelope(type, apiName, content, spec);
}

function validateAuraBundle(
  apiName: string,
  files: Record<string, string>,
  main: string,
): void {
  const kind = main.slice(apiName.length);
  const metaName = `${main}-meta.xml`;
  const allowed = new Set([
    main,
    metaName,
    ...(AURA_SECONDARIES[kind] ?? []).map((s) => `${apiName}${s}`),
  ]);
  for (const [rel, body] of Object.entries(files)) {
    if (!allowed.has(rel)) {
      const reason = /(Provider|Model|Test)\.js$/.test(rel)
        ? `"${rel}" is not a deployable Aura definition — Provider/Model/Test files are not ` +
          `part of the bundle format`
        : rel.endsWith('-meta.xml')
          ? `"${rel}" — the only meta file is "${metaName}", named after the primary`
          : rel === `${apiName}.design`
            ? `"${rel}" — a .design belongs only to a component (.cmp) bundle`
            : !rel.startsWith(apiName)
              ? `"${rel}" — every file in an Aura bundle starts with the bundle name ` +
                `"${apiName}"`
              : `"${rel}" is not a valid file for a ${kind} bundle`;
      throw new ContrailError(`AuraDefinitionBundle ${apiName}: ${reason}.`, 'bad_component');
    }
    if (Buffer.byteLength(body, 'utf8') > AURA_MAX_FILE_BYTES) {
      throw new ContrailError(
        `AuraDefinitionBundle ${apiName}: "${rel}" exceeds the 1,000,000-byte per-file limit.`,
        'bad_component',
      );
    }
  }
}

/**
 * S30: parse and validate a Contrail bundle envelope. Security posture
 * mirrors validateTypeAndName: absolute rejects ('\\', '..') come first for
 * every path, then the tight per-segment grammar — these strings become zip
 * entry names and snapshot paths. S41: returns the resolved MAIN file too
 * (multi-candidate types like Aura pick exactly one primary), and enforces
 * flat/requireMainMeta per the FileSpec.
 */
export function parseBundleEnvelope(
  type: string,
  apiName: string,
  content: string,
  spec: FileSpec,
): { files: Record<string, string>; main: string } {
  const suffixes = Array.isArray(spec.envelopeMainSuffix)
    ? spec.envelopeMainSuffix
    : [spec.envelopeMainSuffix ?? spec.ext];
  const exampleMain = `${apiName}${suffixes[0] ?? ''}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ContrailError(
      `${type} ${apiName}: content must be a Contrail bundle envelope — JSON of the shape ` +
        `{"contrail_bundle":1, "files": {"${exampleMain}": "<xml>", "input/schema.json": "…"}}. ` +
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
    // S41: flat bundle types take no subfolders at all — a '/' is a grammar
    // error here, not a depth question.
    if (spec.flat && rel.includes('/')) {
      throw new ContrailError(
        `${type} ${apiName}: "${rel}" — ${type} bundles are FLAT: no subfolders, every ` +
          `file directly in the bundle directory.`,
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
    // S36: local test trees never deploy (the org would refuse an LWC
    // bundle carrying __tests__ with a worse message) — and the same goes
    // for every bundle type, so the reject is generic (and case-blind:
    // "__Tests__" would just fail org-side instead).
    if (segs.some((s) => s.toLowerCase() === '__tests__')) {
      throw new ContrailError(
        `${type} ${apiName}: envelope path "${rel}" — local test files never deploy. ` +
          `Carry only the files a retrieve shows.`,
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
  // S41: resolve the main file. Single-candidate types keep the S30 error;
  // multi-candidate types (Aura) get zero-primary and two-primary refusals
  // of their own, because those are DIFFERENT authoring mistakes.
  const candidates = suffixes.map((s) => `${apiName}${s}`);
  const mains = candidates.filter((f) => f in out);
  if (mains.length === 0) {
    throw new ContrailError(
      candidates.length === 1
        ? `${type} ${apiName}: envelope is missing its main file "${candidates[0]}".`
        : `${type} ${apiName}: envelope has NO primary file — exactly one of ` +
          `${candidates.join(', ')} is required.`,
      'bad_component',
    );
  }
  if (mains.length > 1) {
    throw new ContrailError(
      `${type} ${apiName}: envelope carries MORE THAN ONE primary (${mains.join(', ')}) — ` +
        `a bundle has exactly one.`,
      'bad_component',
    );
  }
  const main = mains[0]!;
  // S41: the main's own -meta.xml, named after whichever primary was found.
  if (spec.requireMainMeta && !(`${main}-meta.xml` in out)) {
    throw new ContrailError(
      `${type} ${apiName}: envelope is missing "${main}-meta.xml" — Contrail requires the ` +
        `bundle meta on deploy to pin apiVersion (the platform would silently default it; ` +
        `retrieves of old bundles may lack one — add it).`,
      'bad_component',
    );
  }
  // S34: some bundles have more than one REQUIRED file (an AiAuthoringBundle
  // is exactly <Name>.agent + <Name>.bundle-meta.xml) — missing one would
  // fail org-side with a worse message, or worse, deploy a half bundle.
  const alsoRequired = (spec.requiredSuffixes ?? []).map((s) => `${apiName}${s}`);
  for (const name of alsoRequired) {
    if (!(name in out)) {
      throw new ContrailError(
        `${type} ${apiName}: envelope is missing required file "${name}" — this bundle ` +
          `type requires ${[main, ...alsoRequired].join(' + ')}.`,
        'bad_component',
      );
    }
  }
  if (type === 'AuraDefinitionBundle') validateAuraBundle(apiName, out, main);
  return { files: out, main };
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
    const fileSpec = typeEntry(FILE_TYPES, c.type);
    if (fileSpec?.envelope) {
      const { files: bundleFiles } = parseBundleEnvelope(c.type, c.api_name, c.content, fileSpec);
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
    const childSpec = typeEntry(CHILD_TYPES, c.type);
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

  const packageXml = manifestXml(members, apiVersionNumber, 'Package', true);
  files.set('package.xml', strToU8(packageXml));

  let destructiveXml: string | null = null;
  if (deletions.length > 0) {
    const delMembers = new Map<string, string[]>();
    for (const d of deletions) {
      // Folder components delete as members of their content type too
      // (deleting ReportFolder:Ops emits <members>Ops</members> under
      // <name>Report</name>); unknown types keep the ungated literal path.
      const manifestType = typeEntry(FILE_TYPES, d.type)?.manifestType ?? d.type;
      const list = delMembers.get(manifestType) ?? [];
      list.push(d.api_name);
      delMembers.set(manifestType, list);
    }
    destructiveXml = manifestXml(delMembers, apiVersionNumber, 'Package', false);
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

/**
 * S44: <types> blocks whose package.xml position must FOLLOW another's. No
 * pair Contrail shipped before this had an ordering mechanism (children
 * merge into their CustomObject document; folders share their content
 * type's block; everything else is plain alphabetical), but Salesforce's
 * custom-scorer guide documents ONE requirement: a
 * GenAiPromptTemplate deployed with the AiAgentScorerDefinition that engines
 * on it must appear BEFORE the scorer ("Metadata API deploys types in the
 * order that they appear"). Alphabetical puts the scorer first, so this table
 * moves it after the template. Whether alphabetical actually FAILS is
 * unverified (live pair deploy pending) — the mechanism is harmless if it
 * turns out unnecessary. Deploy manifest ONLY: the destructive manifest is
 * left alphabetical because no ordering requirement is documented for
 * deletes.
 */
const MANIFEST_TYPE_AFTER: Record<string, string[]> = {
  AiAgentScorerDefinition: ['GenAiPromptTemplate'],
};

/** Alphabetical; then each MANIFEST_TYPE_AFTER key moves just past the last type it must follow. */
function orderManifestTypes(types: string[], dependencyOrder: boolean): string[] {
  const sorted = [...types].sort((a, b) => a.localeCompare(b));
  if (!dependencyOrder) return sorted;
  for (const [late, befores] of Object.entries(MANIFEST_TYPE_AFTER)) {
    const i = sorted.indexOf(late);
    if (i < 0) continue;
    const lastBefore = Math.max(...befores.map((b) => sorted.indexOf(b)));
    if (lastBefore > i) {
      sorted.splice(i, 1);
      sorted.splice(lastBefore, 0, late);
    }
  }
  return sorted;
}

function manifestXml(
  members: Map<string, string[]>,
  apiVersionNumber: string,
  root: 'Package',
  dependencyOrder: boolean,
): string {
  const types = orderManifestTypes([...members.keys()], dependencyOrder)
    .map((type) => {
      const names = members.get(type)!;
      return (
        `    <types>\n${names
          .sort()
          .map((n) => `        <members>${escapeXml(n)}</members>`)
          .join('\n')}\n        <name>${escapeXml(type)}</name>\n    </types>`
      );
    })
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
  opts?: {
    /**
     * S41: zip entry names (as unzipped) for multi-primary bundle types —
     * the real main is resolved by probing the candidates against what the
     * zip actually holds, never guessed: the S28 capture reads deployed
     * bytes back through this, and a path that "may" exist would silently
     * capture nothing (this function's own contract, above).
     */
    zipEntries?: string[];
  },
):
  | { path: string; child: false; bundleDir?: string; mainCandidates?: string[] }
  | { path: string; child: true; childTag: string; childName: string }
  | null {
  const childSpec = typeEntry(CHILD_TYPES, type);
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
  const spec = typeEntry(FILE_TYPES, type);
  if (!spec) return null;
  if (spec.envelope) {
    // S30 bundle: path = the main file; bundleDir = the whole component's
    // prefix, so the S28 capture reader can gather EVERY entry.
    const dirPrefix = `${spec.dir}/${fileSafeSegment(apiName)}/`;
    const suffixes = Array.isArray(spec.envelopeMainSuffix)
      ? spec.envelopeMainSuffix
      : [spec.envelopeMainSuffix ?? spec.ext];
    const candidates = suffixes.map((s) => `${dirPrefix}${apiName}${s}`);
    const resolved =
      candidates.length === 1
        ? candidates[0]!
        : candidates.find((p) => opts?.zipEntries?.includes(p));
    if (resolved === undefined) {
      // Multi-primary type with no zip to probe: bundleDir alone is still
      // honest (the S28 capture gathers every entry under it and never
      // reads `path` for bundles); a guessed main path is not — it could
      // name a file the zip does not hold. path stays empty by contract;
      // mainCandidates lets a caller with the files resolve it itself.
      return { path: '', child: false, bundleDir: dirPrefix, mainCandidates: candidates };
    }
    return { path: resolved, child: false, bundleDir: dirPrefix };
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
  const spec = typeEntry(FILE_TYPES, type);
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
  if (type === 'AuraDefinitionBundle') {
    // S41: deploy names are namespace-free Lightning developer names —
    // deliberately stricter than NAME_RE (no dots, dashes, spaces). A
    // double-underscore name is a MANAGED member: the index and read path
    // serve ns__Name bundles, a deploy refuses them.
    if (/__/.test(name)) {
      throw new ContrailError(
        `AuraDefinitionBundle "${name}": a namespaced bundle (ns__Name) belongs to its ` +
          `package — only namespace-free bundles deploy through Contrail (reading it ` +
          `still works via retrieve_metadata).`,
        'bad_component',
      );
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.endsWith('_')) {
      throw new ContrailError(
        `invalid AuraDefinitionBundle name "${name}" — a Lightning developer name: start ` +
          `with a letter; letters, digits, single underscores; no trailing underscore.`,
        'bad_component',
      );
    }
    return;
  }
  if (type === 'OmniDataTransform') {
    // S47: per Salesforce Help, with the Omnistudio Metadata setting on
    // (the only state in which the Metadata API deploys these) a Data
    // Mapper name holds letters and digits only — no underscores, dashes or
    // spaces. The fullName is most likely <Name>_<version> (Salesforce's
    // guides name the files that way; not yet confirmed against an org), so
    // both the bare name and one _<digits> suffix are accepted.
    if (!/^[A-Za-z0-9]+(_[0-9]+)?$/.test(name)) {
      throw new ContrailError(
        `invalid OmniDataTransform name "${name}" — letters and digits, optionally ` +
          `_<version> (e.g. AccountSummaryExtract_1). Per Salesforce Help, Data Mapper ` +
          `names hold letters and digits only once Omnistudio Metadata is on; Salesforce's ` +
          `guides name the files <Name>_<version> (exact fullName rule not yet confirmed).`,
        'bad_component',
      );
    }
    return;
  }
  if (!NAME_RE.test(name) || name.includes('/')) {
    throw new ContrailError(`invalid component name "${name}"`, 'bad_component');
  }
}

/** S46 D1: the existing type/name grammar (validateTypeAndName, above) as a predicate. */
export function isValidComponentName(type: string, name: string): boolean {
  try {
    validateTypeAndName(type, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * S45: what changeDependentWarnings needs to know about one component — the
 * classification, the proposal, and the copy it was classified against.
 */
export interface ChangeWarningInput {
  type: string;
  api_name: string;
  change: ComponentChange['change'];
  /** The proposed document (or child block); a bundle's envelope for bundle types. */
  proposed: string;
  /**
   * The copy the classification compared against — the snapshot's in
   * analyzeChanges, the org's live pre-image when the engine re-runs this —
   * or null when there is none (an add, an unreadable or incomparable copy).
   * Documents and children only; bundles pass `bundleFiles`.
   */
  before: string | null;
  /**
   * Bundle types: the proposed files, the envelope's main file, and the
   * baseline's files (rel → body; {} for an add) — compared per file.
   */
  bundleFiles?: {
    proposed: Record<string, string>;
    main: string;
    before: Record<string, string>;
  };
  /**
   * INERT UNTIL PLACED: does anything in this package or the snapshot
   * reference c:<api_name>? Asked only when that arm needs the answer;
   * without it the arm stays silent (it would assert an unchecked absence).
   */
  referenced?: () => boolean;
}

/**
 * S45: the CHANGE-DEPENDENT warning arms of analyzeChanges — every advisory
 * whose truth depends on the classification (add / modify /
 * unchanged_content) or on the copy the proposal was compared against.
 * Pure. analyzeChanges calls it with the SNAPSHOT copy; the engine calls it
 * again with the LIVE copy for every row with a comparable live copy (a
 * row the validate-time live check reclassified, or a MODIFY that stayed a
 * MODIFY — its diff is against live), and swaps these warnings for the
 * stale ones. The arms keep analyzeChanges' own order; for every type they
 * precede its change-independent advisories.
 */
export function changeDependentWarnings(input: ChangeWarningInput): string[] {
  const { type, api_name, change, proposed, before } = input;
  const warnings: string[] = [];
  if (input.bundleFiles) {
    const { proposed: newFiles, main, before: oldFiles } = input.bundleFiles;
    if (change === 'modify') {
      const added = Object.keys(newFiles).filter((k) => !(k in oldFiles));
      const removed = Object.keys(oldFiles).filter((k) => !(k in newFiles));
      const changed = Object.keys(newFiles).filter(
        (k) => k in oldFiles && oldFiles[k]!.trim() !== newFiles[k]!.trim(),
      );
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
        `BUNDLE REPLACE — this deploy replaces the org's whole ${type} directory ` +
          `(${Object.keys(newFiles).length} files; ${delta}).`,
      );
    }
    if (type === 'GenAiPlannerBundle' && change === 'modify') {
      warnings.push(
        `AGENT MUST BE DEACTIVATED FIRST — deploying GenAiPlannerBundle changes for an ` +
          `ACTIVE agent version fails, and version-suffixed bundles are PUBLISHED ` +
          `SNAPSHOTS: a modified deploy of one fails org-side even deactivated ` +
          `(unmodified re-deploys "succeed" as no-ops). Deactivate first ` +
          `(agent_activation_propose/execute, or Agent Builder), deploy, then ` +
          `reactivate; verify with BotVersion.Status. On Agent-Script agents the ` +
          `next publish overwrites hand-edits.`,
      );
    }
    if (type === 'AuraDefinitionBundle') {
      const kind = main.slice(api_name.length);
      const oldMain = ['.cmp', '.app', '.evt', '.intf', '.tokens']
        .map((s) => `${api_name}${s}`)
        .find((f) => f in oldFiles);
      // S41 API VERSION: crossing 39/40 toggles Lightning Locker for the
      // component in orgs still on Locker. Phrased carefully: LWS is an
      // ORG setting — the bundle's apiVersion has no effect on it.
      const verOf = (files: Record<string, string>, mainName: string | undefined): number =>
        mainName
          ? parseFloat(files[`${mainName}-meta.xml`]?.match(/<apiVersion>\s*([\d.]+)/)?.[1] ?? '')
          : NaN;
      const newVer = verOf(newFiles, main);
      const oldVer = verOf(oldFiles, oldMain);
      if (
        Number.isFinite(newVer) &&
        Number.isFinite(oldVer) &&
        newVer < 40 !== oldVer < 40
      ) {
        warnings.push(
          `API VERSION ${oldVer} → ${newVer} crosses the 39/40 boundary — in orgs still ` +
            `on Lightning Locker this toggles Locker for the component (LWS is an org ` +
            `setting, unaffected by apiVersion).`,
        );
      }
      // S41 INERT UNTIL PLACED: a surface-declaring component that nothing
      // references renders nowhere — the exact hand-made-voiceCallPop trap
      // (deployed, green, invisible).
      const mainBody = newFiles[main] ?? '';
      const isBackgroundItem = /lightning:backgroundUtilityItem/.test(mainBody);
      if (
        change === 'add' &&
        (kind === '.cmp' || kind === '.app') &&
        /lightning:(backgroundUtilityItem|utilityItem|availableForFlow(Actions|Screens))|flexipage:availableFor\w*|force:lightningQuickAction/.test(
          mainBody,
        ) &&
        input.referenced !== undefined &&
        !input.referenced()
      ) {
        warnings.push(
          `INERT UNTIL PLACED — this component declares surface interfaces but nothing ` +
            `in this package or the snapshot references c:${api_name}; it renders ` +
            `NOWHERE until host metadata places it` +
            (isBackgroundItem
              ? ` (a background utility item sits in a utility bar's Background region, ` +
                `and the bar needs at least one VISIBLE item or it does not appear).`
              : `.`),
        );
      }
      if (change !== 'unchanged_content') {
        warnings.push(
          `The deploy compiles markup and design (each design:attribute must match an ` +
            `aura:attribute) and parses the JS; runtime errors in a background item ` +
            `surface only in the browser console. Consoles already open keep the OLD ` +
            `definition until reloaded.`,
        );
      }
    }
    return warnings;
  }
  if (type === 'CustomField' && before) {
    const oldType = before.match(/<type>([^<]+)<\/type>/)?.[1];
    const newType = proposed.match(/<type>([^<]+)<\/type>/)?.[1];
    if (oldType && newType && oldType !== newType) {
      warnings.push(
        `FIELD TYPE CHANGE ${oldType} → ${newType} — possible irreversible data loss`,
      );
    }
  }
  // Full-document UI types replace, never merge: an element missing from
  // the proposed content is REMOVED from the org's definition.
  if (
    (type === 'FlexiPage' ||
      type === 'CustomApplication' ||
      type === 'Layout' ||
      type === 'Report' ||
      type === 'Dashboard' ||
      type === 'GenAiPlugin' ||
      type === 'GenAiPromptTemplate' ||
      type === 'Bot' ||
      type === 'LeadConvertSettings' ||
      type === 'NamedCredential' ||
      type === 'ExternalCredential' ||
      type === 'AuthProvider' ||
      type === 'PermissionSetGroup' ||
      type === 'MutingPermissionSet' ||
      // S44: both agent-test suite types are single documents of
      // <testCase> blocks (the legacy one was a parity gap since S30).
      // AiAgentScorerDefinition is deliberately NOT here — its versions
      // are documented append-only, which makes the generic "removed"
      // sentence false; it has its own arm below.
      type === 'AiEvaluationDefinition' ||
      type === 'AiTestingDefinition') &&
    change === 'modify'
  ) {
    warnings.push(
      `WHOLE-DOCUMENT REPLACE — this deploy fully replaces the org's ${type}; ` +
        `anything not present in the proposed content is removed.` +
        (type === 'Bot'
          ? ' A <botVersions> block omitted from a Bot document is a VERSION DELETE.'
          : type === 'LeadConvertSettings'
            ? ' An <objectMapping> omitted here is a lead field mapping DELETED org-wide.'
            : type === 'ExternalCredential'
              ? ' A principal parameter omitted here is DELETED org-side — along with the' +
                ' credential values a human entered for it in Setup.'
              : type === 'PermissionSetGroup'
                ? ' A <permissionSets> member omitted here is DETACHED from the group' +
                  ' org-side — users assigned the group lose that permission set.'
                : type === 'MutingPermissionSet'
                  ? ' A muted permission omitted here is UN-MUTED org-side, silently' +
                    ' RESTORING it to every user assigned the group.'
                  : type === 'AiEvaluationDefinition' ||
                      type === 'AiTestingDefinition'
                    ? ' A <testCase> omitted here is removed from the suite org-side.'
                    : ''),
    );
  }
  // S30: the activeVersionIdentifier is an org-generated token. Altering
  // it by hand mis-targets (or fails) the active-version pointer — the
  // doctrine is retrieve-first, then modify the retrieved copy.
  if (type === 'GenAiPromptTemplate' && change === 'modify') {
    const oldId = before?.match(/<activeVersionIdentifier>([^<]*)</)?.[1];
    const newId = proposed.match(/<activeVersionIdentifier>([^<]*)</)?.[1];
    if (oldId && newId && oldId !== newId) {
      warnings.push(
        `activeVersionIdentifier ALTERED (${oldId.slice(0, 12)}… → ${newId.slice(0, 12)}…) — ` +
          `these tokens are org-generated; a hand-edited value is rejected or mis-targets ` +
          `the active version. To activate a new version, retrieve after deploying it and ` +
          `repoint using the versionIdentifier the org minted.`,
      );
    }
  }
  // S44: scorer versions are documented APPEND-ONLY org-side, which makes
  // the generic WHOLE-DOCUMENT REPLACE sentence a lie for this type — a
  // <scorerVersion> the document omits is NOT removed — so the type has
  // its own arm. Status is documented one-way (Draft → Available →
  // Archived). What the org does with an omission or a regression
  // (refuse, ignore) is NOT live-confirmed, so the text names only what
  // is documented. The version/status scan is bounded regex (the
  // activeVersionIdentifier precedent): it names what it can see; the
  // org is the authority.
  if (type === 'AiAgentScorerDefinition' && change === 'modify') {
    const oldVersions = scorerVersionStatuses(before ?? '');
    const newVersions = scorerVersionStatuses(proposed);
    const omitted = [...oldVersions.keys()].filter((n) => !newVersions.has(n));
    const regressed = [...oldVersions.entries()]
      .filter(([n, was]) => {
        const now = newVersions.get(n);
        return (
          now !== undefined &&
          SCORER_STATUS_RANK[was] !== undefined &&
          SCORER_STATUS_RANK[now] !== undefined &&
          SCORER_STATUS_RANK[now]! < SCORER_STATUS_RANK[was]!
        );
      })
      .map(([n, was]) => `${n} (${was} → ${newVersions.get(n)})`);
    warnings.push(
      `SCORER VERSIONS ARE APPEND-ONLY — the org never deletes a <scorerVersion>: one ` +
        `omitted from this document is NOT removed` +
        (omitted.length > 0 ? ` (org-side versions omitted here: ${omitted.join(', ')})` : '') +
        `. Status is documented one-way (Draft → Available → Archived); a regression ` +
        `here is not something the org performs` +
        (regressed.length > 0 ? ` (regressed here: ${regressed.join('; ')})` : '') +
        `. Retrieve-first, carry every existing version forward, edit only Draft versions.`,
    );
  }
  // S47: a Data Mapper is one document of <omniDataTransformItem> rows, but
  // whether a modify REMOVES the rows its file omits is not confirmed — so
  // the type stays OUT of the WHOLE-DOCUMENT REPLACE list above (its
  // sentence states removal as fact) and gets its own hedged arm. Nor is
  // it documented what a deploy over an existing Data Mapper does at all:
  // Salesforce Help says that once Data Mapper Versioning is on an active
  // version can't be edited, so the org may refuse the modify or land it
  // some other way. The arm states neither as fact.
  if (type === 'OmniDataTransform' && change === 'modify') {
    warnings.push(
      `MODIFY OF AN EXISTING DATA MAPPER — whether the org updates it in place (per ` +
        `Salesforce Help, an active version can't be edited once Data Mapper Versioning is ` +
        `on) is not confirmed, nor whether mapping rows omitted here are removed org-side; ` +
        `carry every row from a fresh retrieve.`,
    );
  }
  // Folder definitions replace their sharing wholesale: the folderShares
  // in this content ARE the folder's sharing after the deploy.
  if ((type === 'ReportFolder' || type === 'DashboardFolder') && change === 'modify') {
    warnings.push(
      `FOLDER REPLACE — the folderShares in this content fully replace the ` +
        `folder's sharing; shares omitted here are revoked.`,
    );
  }
  // Custom metadata records deploy as full replacements too: a field with
  // no <values> entry in this content is reset on the org's record.
  if (type === 'CustomMetadata' && change === 'modify') {
    warnings.push(
      `FULL-RECORD REPLACE — fields omitted from this content are reset to ` +
        `null/default on the deployed record.`,
    );
  }
  // S36: a quick action deploys into a vacuum — surfacing is a layout
  // concern (Layout-assignment precedent below).
  if (type === 'QuickAction' && change === 'add') {
    warnings.push(
      `NEW QUICK ACTION is surfaced NOWHERE until a page layout, a global publisher ` +
        `layout, or a Lightning record page using dynamic actions includes it — this ` +
        `deploy creates the action but places it on no UI.`,
    );
  }
  // A layout deploy never assigns the layout: assignment lives in Profile
  // metadata (layoutAssignments) or Setup. Say so for NEW layouts, which
  // otherwise deploy and then sit unused.
  if (type === 'Layout' && change === 'add') {
    warnings.push(
      `NEW LAYOUT IS NOT ASSIGNED by this deploy — profiles keep their current ` +
        `layout until layoutAssignments change (Profile metadata or Setup).`,
    );
  }
  // Report/dashboard access is FOLDER sharing, not permission sets — no
  // permission-coverage arm can exist for these (see the note in
  // analyzePermissionCoverage), so the honesty lives here instead.
  if ((type === 'Report' || type === 'Dashboard') && change === 'add') {
    warnings.push(
      `NEW ${type.toUpperCase()} visibility is governed by its FOLDER's sharing ` +
        `(folderShares on the folder component), not by permission sets — this ` +
        `deploy grants nobody new access by itself.`,
    );
  }
  // S30: a NET-NEW prompt template carrying a hand-typed identifier cannot
  // be right — the org mints these tokens on deploy.
  if (
    type === 'GenAiPromptTemplate' &&
    change === 'add' &&
    /<activeVersionIdentifier>[^<]/.test(proposed)
  ) {
    warnings.push(
      `activeVersionIdentifier on a NET-NEW template — this token is org-generated and ` +
        `cannot be authored from scratch. Omit it (the org mints one on deploy), or ` +
        `retrieve-first if this template already exists under another name.`,
    );
  }
  // S30/S34: the deactivate gate. Topic/action/instruction changes against
  // an ACTIVE agent version fail org-side — since S34, each flip rides its
  // own Contrail ritual (agent_activation_propose/execute); check state
  // with soql_query on BotVersion.Status. (The GenAiPlannerBundle flavor
  // of this warning lives in the envelope branch above.)
  if (type === 'GenAiPlugin' && change === 'modify') {
    warnings.push(
      `AGENT MUST BE DEACTIVATED FIRST — deploying ${type} changes for an ACTIVE ` +
        `agent version fails. Deactivate first (agent_activation_propose/execute, ` +
        `or Agent Builder), deploy, then reactivate — each flip its own approval; ` +
        `verify with BotVersion.Status.`,
    );
  }
  // S33: a NEW external credential defines principals but carries NO secret
  // values and grants NO access — both of those are post-deploy steps, and
  // silence here would let "deployed" read as "working".
  if (type === 'ExternalCredential' && change === 'add') {
    warnings.push(
      `NEW EXTERNAL CREDENTIAL carries no secrets and grants nobody access — a human ` +
        `enters each principal's credential values in Setup (External Credentials) after ` +
        `the deploy, and callouts fail until a permission set grants ` +
        `externalCredentialPrincipalAccesses for its principals.`,
    );
  }
  return warnings;
}

/**
 * S41 INERT UNTIL PLACED's reference test: does another component in this
 * package, or any snapshot dependency edge, reference c:<name>? S45:
 * exported so the engine asks the same question when the live check turns
 * an Aura bundle into an ADD.
 */
export function auraBundleReferenced(
  db: ContrailDb,
  conn: ConnectionRecord,
  components: ProposedComponent[],
  c: ProposedComponent,
): boolean {
  const refRe = new RegExp(`c:${c.api_name}\\b`);
  return (
    components.some((o) => o !== c && refRe.test(o.content)) ||
    db.edgesTo(conn.id, 'AuraDefinitionBundle', c.api_name).length > 0
  );
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
  // The Aura controller advisory below asks the package's grants about each
  // bundle's controller: one grant index for the whole package, on first use.
  let packageGrants: ReturnType<typeof grantChecker> | undefined;
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
    const envSpec = typeEntry(FILE_TYPES, c.type);
    if (envSpec?.envelope) {
      const { files: proposed, main: mainFile } = parseBundleEnvelope(
        c.type,
        c.api_name,
        c.content,
        envSpec,
      );
      const existingBundle = db.getArtifact(conn.id, c.type, c.api_name);
      const warnings: string[] = [];
      let change: ComponentChange['change'];
      const old = existingBundle ? readBundleFiles(store, conn, envSpec.dir, c.api_name) : {};
      if (!existingBundle) {
        change = 'add';
      } else {
        const added = Object.keys(proposed).filter((k) => !(k in old));
        const removed = Object.keys(old).filter((k) => !(k in proposed));
        const changed = Object.keys(proposed).filter(
          (k) => k in old && old[k]!.trim() !== proposed[k]!.trim(),
        );
        change =
          added.length + removed.length + changed.length === 0 ? 'unchanged_content' : 'modify';
      }
      // S45: the change-dependent arms (BUNDLE REPLACE, the planner's
      // deactivate gate, Aura's apiVersion / INERT UNTIL PLACED / compile
      // advisories) live in one pure helper, so the engine can re-run them
      // against the LIVE copy when the live check reclassifies this entry.
      warnings.push(
        ...changeDependentWarnings({
          type: c.type,
          api_name: c.api_name,
          change,
          proposed: c.content,
          before: null,
          bundleFiles: { proposed, main: mainFile, before: old },
          referenced: () => auraBundleReferenced(db, conn, components, c),
        }),
      );
      if (c.type === 'AiAuthoringBundle') {
        // S34 D1: fires on EVERY draft deploy by design — it IS the honesty
        // contract that made Agent Script deployable at all.
        warnings.push(
          `DRAFT STAGE ONLY — this deploy stages Agent Script as a draft in Agentforce ` +
            `Studio. Nothing is compiled and the RUNNING AGENT IS UNCHANGED: topics, ` +
            `actions, and behavior go live only when a human publishes the draft ` +
            `(Agentforce Studio, or Salesforce's Agentforce DX publish command). A green ` +
            `deploy here is a staged draft, not a shipped agent.`,
        );
        // S34 D2: <target> links the bundle to an existing runtime version.
        // Known limitation: a CDATA-wrapped or namespace-prefixed target (or
        // a commented-out one) evades/false-positives this text scan — bounded,
        // since linking never compiles anything, D1 always fires, and the
        // org fails a bad target itself.
        const meta = proposed[`${c.api_name}.bundle-meta.xml`];
        const target = meta === undefined ? undefined : xmlTagValue(meta, 'target');
        if (target) {
          warnings.push(
            `TARGET LINK, NOT A COMPILE — <target> pins this bundle to runtime version ` +
              `"${target}"; the deploy FAILS unless that Bot/BotVersion already exists in ` +
              `the org or ships in this same package. Linking never compiles or publishes ` +
              `anything.`,
          );
        }
        // S34 D3: version-suffixed names are platform-owned published snapshots.
        if (/_\d+$/.test(c.api_name)) {
          warnings.push(
            `PUBLISHED-SNAPSHOT NAME — "${c.api_name}" is a version-suffixed published ` +
              `snapshot; the platform owns those. The editable draft is the NAKED bundle ` +
              `name — deploy a suffixed name only when promoting retrieved bytes.`,
          );
        }
      }
      if (c.type === 'AuraDefinitionBundle') {
        const kind = mainFile.slice(c.api_name.length);
        const oldMain = ['.cmp', '.app', '.evt', '.intf', '.tokens']
          .map((s) => `${c.api_name}${s}`)
          .find((f) => f in old);
        // S41 KIND CHANGE: what the platform does to a bundle whose primary
        // kind changes under the same name is untested (spec Q8) — refuse
        // rather than find out on a client org. Attributed to the SNAPSHOT,
        // which is what this reads: after an out-of-band delete the stale
        // copy false-positives until a refresh, so the remedy names it.
        // (The live-rows flavor of this refusal lives in auraLiveChecks.)
        if (oldMain && oldMain.slice(c.api_name.length) !== kind) {
          throw new ContrailError(
            `AuraDefinitionBundle ${c.api_name}: the SNAPSHOT's copy of this bundle is ` +
              `${oldMain.slice(c.api_name.length)} and this envelope is ${kind} — changing ` +
              `a bundle's kind under the same name is untested platform behavior. Delete ` +
              `the old bundle first (its own destructive approval) or use a new name; if ` +
              `the org-side bundle already changed since the last refresh, run ` +
              `refresh_snapshot types:["AuraDefinitionBundle"] and validate again.`,
            'bad_component',
          );
        }
        // (API VERSION, INERT UNTIL PLACED and the compile advisory are
        // change-dependent: changeDependentWarnings, above.)
        const mainBody = proposed[mainFile] ?? '';
        // Server-side controller: ordinary Apex class access — said HERE as
        // an advisory on the bundle, not through the coverage table, whose
        // wording ("this package ADDS components … they will deploy") is
        // written for components IN the package and would overstate for a
        // controller class that may be long-deployed and already granted.
        const controller = mainBody.match(/\bcontroller="([A-Za-z][A-Za-z0-9_]*)"/)?.[1];
        if (controller) {
          // The coverage table's class-grant test (the controller name is
          // letters, digits and underscores, so nothing in it needs escaping).
          packageGrants ??= grantChecker(
            components
              .filter((p) => p.type === 'PermissionSet' || p.type === 'Profile')
              .map((p) => p.content)
              .join('\n'),
          );
          if (!packageGrants('class', controller)) {
            warnings.push(
              `server-side controller "${controller}" — users need Apex class access ` +
                `(classAccesses) for it, and no permission set in this package grants it ` +
                `(it may already be granted org-side; not checkable from here).`,
            );
          }
        }
      }
      changes.push({ type: c.type, api_name: c.api_name, change, warnings, ...sourceOf(c) });
      continue;
    }

    const existing = db.getArtifact(conn.id, c.type, c.api_name);
    const warnings: string[] = [];
    let change: ComponentChange['change'];
    let oldContent: string | null = null;
    if (!existing) {
      change = 'add';
    } else {
      oldContent = existing.filePath
        ? readOldContent(store, conn, c.type, c.api_name, existing.filePath)
        : null;
      change = oldContent !== null && oldContent.trim() === c.content.trim()
        ? 'unchanged_content'
        : 'modify';
    }
    // S45: every arm whose truth depends on the classification or on the
    // copy it was compared against (FIELD TYPE CHANGE, the REPLACE family,
    // the add-only advisories, the deactivate gate …) lives in one pure
    // helper, so the engine can re-run them against the LIVE copy when the
    // live check reclassifies this entry. For every type they precede its
    // change-independent advisories below, so the order is unchanged.
    warnings.push(
      ...changeDependentWarnings({
        type: c.type,
        api_name: c.api_name,
        change,
        proposed: c.content,
        before: oldContent,
      }),
    );
    // S44: the Studio suite type is BETA (Salesforce's own label for the type
    // AND its runner) and a deploy of one runs nothing — fires on add AND
    // modify (S34 D1 precedent: the honesty rides every deploy).
    if (c.type === 'AiTestingDefinition') {
      warnings.push(
        `BETA SUITE, RUNS NOTHING — this deploy stores an Agentforce Studio test suite; it ` +
          `executes no test. Runs happen through run_agent_eval (on the org probed a deployed ` +
          `suite appeared in the Studio Tests tab only after its first run, never in Testing ` +
          `Center); Salesforce marks both the type and its runner Beta ` +
          `(grammar and runner can change). Contrail does not validate scorer names; per ` +
          `Salesforce's library the ` +
          `org refuses an unknown name at deploy — not yet live-confirmed, so a green deploy ` +
          `never proves a scorer ran.`,
      );
      // S44: Salesforce's guidance keeps single-turn and multi-turn cases in
      // SEPARATE suites (a mixed suite has been reported to stall, and the
      // Studio runner has no cancel endpoint). Advisory only: counts
      // <testCase> blocks with and without <conversationHistory>. No claim
      // about when a stalled run releases its in-progress slot — that
      // timing is undocumented.
      const cases = xmlBlocks(c.content, 'testCase');
      const multi = cases.filter((t) => /<conversationHistory>/.test(t)).length;
      const single = cases.length - multi;
      if (multi > 0 && single > 0) {
        warnings.push(
          `MIXED SINGLE- AND MULTI-TURN CASES — ${multi} case(s) carry <conversationHistory> ` +
            `and ${single} do not. Salesforce's guidance keeps them in separate suites (a ` +
            `mixed suite has been reported to stall, and the Studio runner has no cancel ` +
            `endpoint). Split the suite unless a mixed one has completed on this org.`,
        );
      }
    }
    // S44: std_* scorers are system-provisioned per agent (last modified by
    // Automated Process, live-observed 2026-11-08). What the org does with a
    // human-authored edit of one is NOT live-confirmed — the advisory hedges
    // and fires on add AND modify (an add of a std_ name collides with the
    // org's own provisioning).
    if (c.type === 'AiAgentScorerDefinition' && /^std_/.test(c.api_name)) {
      warnings.push(
        `SYSTEM-PROVISIONED SCORER — Salesforce creates std_* scorers for each agent (last ` +
          `modified by Automated Process); an edit may be overwritten or refused org-side. ` +
          `Author your ` +
          `own scorer name for custom logic.`,
      );
    }
    // S47: Data Mappers — fires on add AND modify (S34 D1 precedent). The
    // setting gate is Salesforce Help's; that <active> carries over on
    // deploy is a Salesforce blog's claim, not yet confirmed; formulaConverted
    // is the Designer's compiled form of a formula, not hand-writable.
    if (c.type === 'OmniDataTransform') {
      warnings.push(
        `OMNISTUDIO DATA MAPPER — deploys only where the org's Omnistudio Metadata setting ` +
          `is on (per Salesforce Help). Its <active> value decides whether it lands active ` +
          `(per a Salesforce blog — not yet confirmed here). Formula items need the Data ` +
          `Mapper Designer (formulaConverted is Designer-computed); check the result in the ` +
          `Designer's Preview.`,
      );
      // Advisory, never a refusal: the fullName rule is not confirmed, so
      // a mismatch may be deliberate. Item rows carry no <uniqueName> in
      // the documented grammar; they are stepped over anyway so only the
      // header's value is read.
      const uniqueName = omniDataTransformUniqueName(c.content);
      if (uniqueName && uniqueName !== c.api_name) {
        warnings.push(
          `UNIQUENAME MISMATCH — api_name ${c.api_name} differs from the file's uniqueName ` +
            `${uniqueName}; Salesforce's guides name Data Mapper files <Name>_<version> ` +
            `(fullName rule not yet confirmed).`,
        );
      }
    }
    // S36: PSG grants are rebuilt asynchronously — fires on add AND modify
    // (S34 D1 precedent: the honesty rides every deploy, by design).
    if (c.type === 'PermissionSetGroup') {
      warnings.push(
        `PERMISSION SET GROUP RECALCULATES ASYNCHRONOUSLY — after this deploy the org ` +
          `rebuilds the group's aggregated permissions (Status: Updating → Updated). ` +
          `Verify with soql_query (SELECT Status FROM PermissionSetGroup WHERE ` +
          `DeveloperName = '${c.api_name}') before relying on the grants.`,
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

  // S41 ORDERING: a package component referencing c:<N> while that Aura/LWC
  // bundle is in neither this package nor the snapshot index deploys a
  // broken reference (or fails org-side) — said on the REFERENCING entry.
  // Advisory by design: the c: scan over host XML can catch prose, and the
  // snapshot may simply not have retrieved bundles yet.
  {
    const packagedBundles = new Set(
      components
        .filter(
          (x) => x.type === 'AuraDefinitionBundle' || x.type === 'LightningComponentBundle',
        )
        .map((x) => x.api_name),
    );
    const refHosts = new Set(['FlexiPage', 'QuickAction', 'Flow', 'CustomTab']);
    // The index is asked once per name for the whole package: a host can
    // repeat one c: name thousands of times. Its lookup ignores ASCII case
    // (COLLATE NOCASE) and a c: name is ASCII, so the answer is kept under
    // the lower-cased name and every spelling of it shares one lookup.
    const indexed = new Map<string, boolean>();
    const inIndex = (name: string): boolean => {
      const key = name.toLowerCase();
      let found = indexed.get(key);
      if (found === undefined) {
        found =
          db.getArtifact(conn.id, 'AuraDefinitionBundle', name) !== null ||
          db.getArtifact(conn.id, 'LightningComponentBundle', name) !== null;
        indexed.set(key, found);
      }
      return found;
    };
    for (const entry of changes) {
      if (!refHosts.has(entry.type)) continue;
      const comp = components.find(
        (x) => x.type === entry.type && x.api_name === entry.api_name,
      );
      if (!comp) continue;
      const missing = new Set<string>();
      for (const m of comp.content.matchAll(/\bc:([A-Za-z][A-Za-z0-9_]*)/g)) {
        const name = m[1]!;
        if (packagedBundles.has(name) || missing.has(name) || inIndex(name)) continue;
        missing.add(name);
        // The warning names the first five; no later name can change it.
        if (missing.size === 5) break;
      }
      if (missing.size > 0) {
        const list = [...missing].slice(0, 5).join(', ');
        entry.warnings.push(
          `references ${list} (c: namespace) — in neither this package nor the snapshot ` +
            `index. If the org lacks the bundle too, this deploy fails or leaves a broken ` +
            `reference; ship the bundle first or in this same package.`,
        );
      }
    }
  }

  const destructive: ComponentChange[] = deletions.map((d) => {
    const warnings: string[] = ['DELETION — cannot be undone by rollback'];
    const existing = db.getArtifact(conn.id, d.type, d.api_name);
    if (!existing) {
      warnings.push('not present in the local snapshot — verify the name before approving');
    }
    // S41 (§3.15): a delete of a type Contrail cannot read gets no
    // type-aware arms — say so where the human decides.
    if (!isRegisteredType(d.type)) {
      warnings.push(
        `UNREGISTERED TYPE DELETE — Contrail cannot read ${d.type} or list its ` +
          `dependents; the component name and the org's own refusal rules are the only ` +
          `checks this delete gets.`,
      );
    }
    // S41: an Aura bundle delete takes the WHOLE bundle (there is no
    // per-file destructive member), and the org refuses while a FlexiPage,
    // Flow, QuickAction, or override still uses it — name the dependents
    // the graph knows about so the refusal isn't a surprise.
    if (d.type === 'AuraDefinitionBundle') {
      const usedBy = db.edgesTo(conn.id, d.type, d.api_name).slice(0, 8);
      warnings.push(
        `deletes the ENTIRE bundle (every file — there is no per-file delete)` +
          (usedBy.length > 0
            ? `; the org will REFUSE while it is referenced — known dependents: ` +
              usedBy.map((e) => `${e.fromType}:${e.fromName}`).join(', ')
            : `; the org refuses the delete if a FlexiPage, Flow, QuickAction, or ` +
              `action override still references it`),
      );
    }
    return { type: d.type, api_name: d.api_name, change: 'delete', warnings };
  });

  // S47 MIXED PACKAGE: Salesforce Help ("Tool Considerations") and a
  // Salesforce KB say Omnistudio components can't share a deploy with setup
  // metadata. Which types count as "setup" is not precisely documented, so
  // ANY other type in the package (components or deletions) draws the
  // advisory on every OmniDataTransform entry — never a local refusal; the
  // org's answer is the authority.
  {
    const packageTypes = new Set([...components, ...deletions].map((x) => x.type));
    if (packageTypes.has('OmniDataTransform') && packageTypes.size > 1) {
      for (const entry of [...changes, ...destructive]) {
        if (entry.type !== 'OmniDataTransform') continue;
        entry.warnings.push(
          `MIXED PACKAGE — Salesforce says Omnistudio components can't share a deploy with ` +
            `setup metadata (permission sets, profiles, fields, FlexiPages, Expression ` +
            `Sets); if the org refuses, deploy the Data Mappers on their own.`,
        );
      }
    }
  }

  return { changes, destructive };
}

/** Provenance fields, present only when the component was read from a file. */
function sourceOf(c: ProposedComponent): { source_path?: string; source_sha256?: string } {
  return c.source_path
    ? { source_path: c.source_path, source_sha256: c.source_sha256 }
    : {};
}

/**
 * S46 D3: what Contrail knows about whether an uncovered component is
 * already in the org — 'new' = the live check found it absent, 'in_org' =
 * the live check found it, 'unknown' = not placed (always, on a dry run and
 * when the live check was unavailable).
 */
export type PermissionPresence = 'new' | 'in_org' | 'unknown';

export interface PermissionCoverage {
  /** Components that need a permission and are NOT granted anywhere in this package. */
  uncovered: Array<{
    type: string;
    api_name: string;
    permission: string;
    presence: PermissionPresence;
  }>;
  /** True if the package itself contains a PermissionSet or Profile. */
  has_permission_container: boolean;
  warning: string | null;
}

/** A single thing that needs a permission grant to be usable. */
interface PermissionNeed {
  type: string;
  api_name: string;
  permission: string;
  kind:
    | 'field'
    | 'object'
    | 'class'
    | 'tab'
    | 'page'
    | 'application'
    | 'agent'
    | 'credentialPrincipal'
    | 'customPermission';
  /**
   * S46 D3: the package component this need lives inside when it is not a
   * component itself — an inline field's CustomObject, a principal's
   * ExternalCredential. A need whose owner is new is new.
   */
  owner?: { type: string; api_name: string };
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
  for (const block of xmlBlocks(xml, 'externalCredentialParameters')) {
    const type = xmlTagValue(block, 'parameterType') ?? '';
    if (!/^(NamedPrincipal|PerUserPrincipal)$/i.test(type)) continue;
    const name = xmlTagValue(block, 'parameterName');
    if (name) names.push(name);
  }
  return names;
}

/** S44: Draft → Available → Archived is the documented one-way status order. */
const SCORER_STATUS_RANK: Record<string, number> = { Draft: 0, Available: 1, Archived: 2 };

/**
 * S44: versionNumber → status for each <scorerVersion> of an
 * AiAgentScorerDefinition (documented grammar; element names live-confirmed
 * from a retrieved std_* scorer 2026-11-08). A text scan, not a parser — the
 * org validates; this only names what the approval page can see.
 */
function scorerVersionStatuses(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of xmlBlocks(xml, 'scorerVersion')) {
    const n = block.match(/<versionNumber>\s*(\d+)\s*<\/versionNumber>/)?.[1];
    const s = block.match(/<status>\s*([A-Za-z]+)\s*<\/status>/)?.[1];
    if (n) out.set(n, s ?? '');
  }
  return out;
}

/**
 * S47: the header <uniqueName> of an OmniDataTransform document, or
 * undefined. The <omniDataTransformItem> rows are stepped over first, so a
 * row's own uniqueName never answers for the mapper. It runs on
 * agent-supplied content before any org call, so both steps are one-walk
 * readers from salesforce/xml.ts, never the lazy patterns they replace:
 * `/<omniDataTransformItem>[\s\S]*?<\/omniDataTransformItem>/g` took 24 s
 * for 1.8 MB of row openers with no closers, and
 * `/<uniqueName>\s*([^<]*?)\s*<\/uniqueName>/` took 19 s for 4,000 spaces
 * after an opener with no closer (both measured on one machine). Either
 * would have blocked every tool on the server meanwhile.
 */
function omniDataTransformUniqueName(content: string): string | undefined {
  return xmlTagValue(withoutXmlBlocks(content, 'omniDataTransformItem'), 'uniqueName', {
    emptyOk: true,
  });
}

/** Custom entities (need explicit object permissions); standard objects don't. */
function isCustomEntity(name: string): boolean {
  return /__(c|b|e|x)$/i.test(name);
}

/** Extract the fullNames of inline <fields> in a CustomObject .object body. */
function inlineFieldNames(objectXml: string): string[] {
  const names: string[] = [];
  for (const block of xmlBlocks(objectXml, 'fields')) {
    const m = block.match(/<fullName>([^<]+)<\/fullName>/);
    if (m?.[1]) names.push(m[1].trim());
  }
  return names;
}

function permissionBlocks(text: string, tag: string): string[] {
  return xmlBlocks(text, tag);
}

/**
 * Where each kind of need is granted: the permission blocks that can grant
 * it, the element inside them that names the component, and the flag that
 * must be on. A grant counts only if the component is named in the right
 * block AND the flag is on — a mention with readable/allowRead/enabled=false
 * (or a Hidden tab) is NOT coverage. False "covered" would defeat the warning.
 */
interface GrantRule {
  blocks: string[];
  name: string;
  /** null: the block grants unless its <visibility> is Hidden or None (tabs). */
  flag: string | null;
}

const GRANT_RULES: Record<PermissionNeed['kind'], GrantRule> = {
  field: { blocks: ['fieldPermissions'], name: 'field', flag: 'readable' },
  object: { blocks: ['objectPermissions'], name: 'object', flag: 'allowRead' },
  class: { blocks: ['classAccesses'], name: 'apexClass', flag: 'enabled' },
  page: { blocks: ['pageAccesses'], name: 'apexPage', flag: 'enabled' },
  application: { blocks: ['applicationVisibilities'], name: 'application', flag: 'visible' },
  // S30: agent access is a REAL PermissionSet block (contrast the
  // Report/Dashboard folder-sharing absence below).
  agent: { blocks: ['agentAccesses'], name: 'agentName', flag: 'enabled' },
  // S33: external credential principals are granted by name
  // "<ExtCredDevName>-<principalName>" in a real PermissionSet block.
  credentialPrincipal: {
    blocks: ['externalCredentialPrincipalAccesses'],
    name: 'externalCredentialPrincipal',
    flag: 'enabled',
  },
  // S36: custom permissions grant via <customPermissions><enabled>true
  // </enabled><name>X</name></customPermissions> (live-confirmed from a
  // real org's permission set; Profiles use the identical block shape).
  customPermission: { blocks: ['customPermissions'], name: 'name', flag: 'enabled' },
  tab: { blocks: ['tabVisibilities', 'tabSettings'], name: 'tab', flag: null },
};

/**
 * Answers whether each need of one package is granted, reading the package's
 * permission set/profile text once per kind of need rather than once per
 * need: a package can carry thousands of inline fields and a profile with
 * thousands of grants.
 *
 * A need is granted when a granting block of its kind matches
 * `<name>\s*API_NAME\s*</name>` with the i flag, API_NAME taken literally:
 * the test this function has always made. Each granting block is filed under
 * regexCaseKey of the trimmed text of each of its `<name>…</name>` elements.
 * The regex can only match an element whose text is the API name with white
 * space around it (unless the name holds "<"), and the trim and the key
 * ignore exactly what `\s*` and the i flag ignore. So for an API name with no
 * "<" and no white space at either end, a block is filed under the name's
 * key exactly when the regex matches it, and the file answers on its own.
 * Any other name runs the regex: on the blocks filed under its trimmed key,
 * or on every block when it holds "<" (it could match across elements).
 *
 * One difference from the old per-need test, on absurd input only: that
 * test compiled the regex for every block of the kind, and V8 refuses to
 * compile one for an API name of about 32,000 characters ("Regular
 * expression too large"), so it threw whenever the package held such a
 * block. A name the file answers is no longer an error.
 */
function grantChecker(
  containerText: string,
): (kind: PermissionNeed['kind'], apiName: string) => boolean {
  const byKind = new Map<PermissionNeed['kind'], (apiName: string) => boolean>();
  const answers = new Map<string, boolean>();
  return (kind, apiName) => {
    const key = `${kind}:${apiName}`;
    let granted = answers.get(key);
    if (granted === undefined) {
      let grants = byKind.get(kind);
      if (grants === undefined) {
        grants = grantIndex(containerText, GRANT_RULES[kind]);
        byKind.set(kind, grants);
      }
      granted = grants(apiName);
      answers.set(key, granted);
    }
    return granted;
  };
}

function grantIndex(containerText: string, rule: GrantRule): (apiName: string) => boolean {
  const flagOn =
    rule.flag === null ? null : new RegExp(`<${rule.flag}>\\s*true\\s*</${rule.flag}>`, 'i');
  const granting: string[] = [];
  for (const tag of rule.blocks) {
    for (const block of permissionBlocks(containerText, tag)) {
      const on = flagOn
        ? flagOn.test(block)
        : !/^(hidden|none)$/i.test(xmlTagValue(block, 'visibility', { ignoreCase: true }) ?? '');
      if (on) granting.push(block);
    }
  }
  const filed = new Map<string, number[]>();
  granting.forEach((block, i) => {
    for (const text of xmlTagTexts(block, rule.name, { ignoreCase: true })) {
      const key = regexCaseKey(text.trim());
      const list = filed.get(key);
      if (list === undefined) filed.set(key, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
  });
  return (apiName) => {
    const holdsLt = apiName.includes('<');
    const trimmed = apiName.trim();
    if (!holdsLt && trimmed === apiName) return filed.has(regexCaseKey(apiName));
    const named = new RegExp(`<${rule.name}>\\s*${escapeRegex(apiName)}\\s*</${rule.name}>`, 'i');
    if (holdsLt) return granting.some((block) => named.test(block));
    const candidates = filed.get(regexCaseKey(trimmed)) ?? [];
    return candidates.some((i) => named.test(granting[i]!));
  };
}

/**
 * A key two strings share exactly when a non-unicode regex with the i flag
 * reads them as the same literal text. Each UTF-16 unit maps as ECMAScript's
 * Canonicalize maps it: to its upper case when that is one unit, unless that
 * would turn a non-ASCII unit into an ASCII one (so "ı" and "ſ" stay apart
 * from "i" and "s"). Compared with V8 for every code unit when written.
 */
function regexCaseKey(s: string): string {
  if (!/[\u0080-\uffff]/.test(s)) return s.toUpperCase();
  let key = '';
  for (let i = 0; i < s.length; i++) {
    const unit = s[i]!;
    const upper = unit.toUpperCase();
    key +=
      upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128)
        ? upper
        : unit;
  }
  return key;
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
 *
 * S47: deliberately NO arm for OmniDataTransform either. No per-component
 * permission-set grant for running a Data Mapper turned up in Salesforce's
 * docs, and what Help does name — object permissions on the Omnistudio
 * config objects for non-admin users who create, update or delete
 * components — is a standing org-setup grant, not a per-component one this
 * table could check. The type page does document a header <requiredPermission>
 * field; what it gates is not yet confirmed, so no arm keys on it.
 *
 * S46 D3: the warning says only what Contrail knows about each uncovered
 * component. `presence(type, apiName)`: true = the live check found it in the
 * org, false = found it absent, null/undefined = not known. Omitted on dry
 * runs and when the live check was unavailable — every component is then
 * 'unknown', and no sentence says the package "adds" it. Up to three
 * sentences, in the order new, in_org, unknown. Which permissions the org
 * already holds is never read here: for a component already in the org the
 * warning says so instead of predicting who can use it.
 */
export function analyzePermissionCoverage(
  components: ProposedComponent[],
  presence?: (type: string, apiName: string) => boolean | null | undefined,
): PermissionCoverage {
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
      // S44: deliberately NO arm for AiEvaluationDefinition,
      // AiTestingDefinition or AiAgentScorerDefinition — a test suite or a
      // custom scorer has no permission-set block at all; who may author and
      // run them is an Agentforce admin user permission, not a per-component
      // grant. The agent a suite tests gets its own agentAccesses arm when it
      // ships in the same package.
      needs.push({ type: 'Bot', api_name: c.api_name, permission: 'agent access (agentAccesses)', kind: 'agent' });
    } else if (c.type === 'CustomPermission') {
      // S36: a custom permission grants nobody anything until a permission
      // set (or profile) enables it. Deliberately NO arm for QuickAction
      // (surfacing is a layout concern — no permission-set block exists),
      // LightningComponentBundle (visibility is isExposed/targets inside its
      // own js-meta.xml), AuraDefinitionBundle (S41: placement is host
      // metadata, and the server-side-controller class-access advisory
      // lives on the bundle's own change entry — this table's wording is
      // for components IN the package and would overstate for a
      // long-deployed controller), or PermissionSetGroup (it's a CONTAINER of
      // permission sets; who holds it is a data question, PermissionSetAssignment).
      // And PSGs are never counted as grant CONTAINERS here either: coverage
      // scans in-package PermissionSet/Profile content only — a PSG whose
      // org-side member grants the permission still warns, correctly, because
      // the advisory can only see the package. Never "fix" that by counting
      // PSG or MutingPermissionSet blocks: a muting set uses the SAME tag
      // names with INVERTED semantics (enabled=true means REVOKED).
      needs.push({
        type: 'CustomPermission',
        api_name: c.api_name,
        permission: 'custom permission access (customPermissions)',
        kind: 'customPermission',
      });
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
          owner: { type: 'ExternalCredential', api_name: c.api_name },
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
          owner: { type: 'CustomObject', api_name: c.api_name },
        });
      }
    }
  }

  // A need answers for itself first; one that cannot (an inline field, a
  // principal) is new when the component it lives inside is new.
  const presenceOf = (need: PermissionNeed): PermissionPresence => {
    const p = presence?.(need.type, need.api_name);
    if (p === true) return 'in_org';
    if (p === false) return 'new';
    if (need.owner && presence?.(need.owner.type, need.owner.api_name) === false) return 'new';
    return 'unknown';
  };

  const isGranted = grantChecker(containerText);
  const uncovered: PermissionCoverage['uncovered'] = needs
    .filter((n) => !isGranted(n.kind, n.api_name))
    .map((n) => ({
      type: n.type,
      api_name: n.api_name,
      permission: n.permission,
      presence: presenceOf(n),
    }));

  const sentences: string[] = [];
  const group = (wanted: PermissionPresence): { n: number; list: string } => {
    const members = uncovered.filter((u) => u.presence === wanted);
    return {
      n: members.length,
      list: members.map((u) => `${u.type}:${u.api_name} (${u.permission})`).join('; '),
    };
  };
  const fresh = group('new');
  if (fresh.n > 0) {
    sentences.push(
      hasContainer
        ? `These new components are not granted by the permission set/profile in this package and ` +
          `will be invisible or inaccessible to users until permissions are set: ${fresh.list}.`
        : `This package adds ${fresh.n} component(s) that need permissions but includes no ` +
          `permission set or profile to grant them — they will deploy but stay invisible or ` +
          `inaccessible until you set permissions (deploy a permission set alongside, or grant FLS/` +
          `access afterward): ${fresh.list}.`,
    );
  }
  const inOrg = group('in_org');
  if (inOrg.n > 0) {
    sentences.push(
      hasContainer
        ? `These components are already in the org and are not granted by the permission ` +
          `set/profile in this package — who can use them depends on the permissions already in ` +
          `the org, which Contrail did not check: ${inOrg.list}.`
        : `This package includes ${inOrg.n} component(s) that are already in the org and need ` +
          `permissions to be usable, and no permission set or profile for them — who can use ` +
          `them depends on the permissions already in the org, which Contrail did not check: ` +
          `${inOrg.list}.`,
    );
  }
  const unplaced = group('unknown');
  if (unplaced.n > 0) {
    sentences.push(
      hasContainer
        ? `These components are not granted by the permission set/profile in this package, and ` +
          `Contrail did not confirm whether they already exist in the org — any that are new ` +
          `will be invisible or inaccessible to users until permissions are set: ${unplaced.list}.`
        : `This package includes ${unplaced.n} component(s) that need permissions to be usable ` +
          `and no permission set or profile to grant them. Contrail did not confirm whether they ` +
          `already exist in the org — any that are new will deploy but stay invisible or ` +
          `inaccessible until you set permissions (deploy a permission set alongside, or grant ` +
          `FLS/access afterward): ${unplaced.list}.`,
    );
  }
  const warning = sentences.length > 0 ? sentences.join(' ') : null;
  return { uncovered, has_permission_container: hasContainer, warning };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * S30: the snapshot's view of a bundle, keyed by path RELATIVE to the bundle
 * directory — the same key shape a Contrail bundle envelope uses, so the
 * change classifier compares like with like. S45: exported — the live
 * pre-image compares a bundle PER FILE against this map (never through
 * readOldContent, whose bundle copy is the main file alone).
 */
export function readBundleFiles(
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

/**
 * The snapshot's copy of one component (a child's block extracted from its
 * container). S45: exported — the approval page's snapshot-baseline diff
 * reads it when the live pre-image is unavailable or not comparable.
 */
export function readOldContent(
  store: SnapshotStore,
  conn: ConnectionRecord,
  type: string,
  apiName: string,
  filePath: string,
): string | null {
  const file = store.readCurrentFile(conn.id, filePath);
  if (file === null) return null;
  const child = typeEntry(CHILD_TYPES, type);
  if (!child) return file;
  // Child artifacts live inside their container file; extract the block.
  const childName = type === 'CustomLabel' ? apiName : apiName.split('.').slice(1).join('.');
  for (const block of xmlBlocks(file, child.tag)) {
    const m = block.match(/<fullName>([^<]+)<\/fullName>/);
    if (m?.[1]?.toLowerCase() === childName.toLowerCase()) return block;
  }
  return null;
}
