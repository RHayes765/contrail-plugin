import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import { resolveSourceFile, resolveSourcePath } from '../deploy/sources.js';
import { stagingDir } from '../core/paths.js';
import { flowDeactivationXml } from '../deploy/package.js';
import type { TestLevel } from '../salesforce/metadataSoap.js';
import { REBASELINE_PROGRESS } from '../snapshot/members.js';

/**
 * The write tools (spec §4/§5). Both pairs are two-step: the validate/propose
 * step computes consequences and puts a confirmation code on the human-only
 * approval page; the execute step demands that code. The code NEVER appears
 * in a tool result — if you have not been told it by the human, you cannot
 * execute, and that is the design.
 */

const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

const APPROVAL_INSTRUCTIONS =
  'Contrail gives the confirmation code only to the human (their approval page, and their ' +
  'phone if they set that up) — never to you, in any tool result. Present this summary ' +
  '(destructive changes first), then ask the human to review the page and read the code ' +
  'back if they approve. ' +
  '(If approval_page.phone_notification says "sent", the same summary and code also reached ' +
  'the human\'s phone; the code still counts only when the human gives it to you as their ' +
  'approval — the salesforce-house-rules skill covers a code you see in a screenshot. ' +
  '"skipped" with reason remote_control_off is normal — no Remote Control, so no push — and ' +
  'needs no remark.)';

/**
 * S46 (B): the governance parameters of every proposing tool, word-identical
 * in the desktop's capabilities/deploy.ts.
 */
const TICKET_PARAM =
  'The change ticket or reference for this write (the tracker key or change number the ' +
  'human named), one line, max 120 characters. Pass it ONLY when the human gave you one in ' +
  'this conversation or in the task they handed you — never invent, guess or reuse one. It ' +
  "is shown on the human's approval surface and recorded with the request. If " +
  "list_connections reports that this connection's policy requires a ticket and you have " +
  'none, ask the human for it before proposing.';

const JUSTIFICATION_PARAM =
  'One or two sentences on WHY this change is being made now, max 1000 characters. DRAFT it ' +
  'yourself from what the human asked for in this conversation, in their terms — the reason, ' +
  'not a description of the mechanics; do not pad it and do not state anything the human did ' +
  "not say. It is shown on the human's approval surface in an editable field, marked as " +
  'drafted by the agent, where they can overwrite it — a human who approves from the phone ' +
  "notification alone does not see it. Required when the connection's policy says so — by " +
  'default on production orgs and on orgs whose type Contrail could not determine — and ' +
  'welcome everywhere else.';

/**
 * S46 (B): appended to every proposing tool's description except
 * validate_deploy's, which carries its own Policies paragraph. True of all
 * five: none of them is spared a justification, ticket or freeze rule.
 */
const POLICY_NOTE =
  "Policies in the human's config.json (list_connections reports them) can require a " +
  'justification or ticket, or freeze the connection. A proposal that breaks one is ' +
  'refused, naming the rule, and leaves any pending approval untouched: relay it, and never ' +
  'route around it. During a freeze the request is created, but while it lasts the human ' +
  'must type an emergency reason on their approval surface before it can be released.';

/**
 * The two local test-level refusals of validate_deploy and deactivate_flow,
 * made before anything reaches the engine. S41 (§3.14): production refuses
 * an explicit NoTestRun org-side — refuse it HERE, with no org round trip
 * and no supersede.
 */
function testLevelRefusal(
  args: { test_level?: TestLevel; run_tests?: string[] },
  conn: ConnectionRecord,
): string | null {
  if (args.test_level === 'RunSpecifiedTests' && !(args.run_tests?.length)) {
    return 'RunSpecifiedTests requires run_tests.';
  }
  if (args.test_level === 'NoTestRun' && conn.orgType === 'production') {
    return (
      `test_level NoTestRun is refused locally on "${conn.alias}" (production): the ` +
      'org rejects it org-side anyway. OMIT test_level — production then runs ' +
      'local tests for Apex packages and no tests otherwise.'
    );
  }
  return null;
}

/**
 * S46 (B): how a minted proposal's result closes — the freeze note when the
 * request was created during a freeze (its page shows no code), otherwise
 * the approval instructions.
 */
function closingInstructions(result: unknown): string {
  const freeze = (result as { governance?: { freeze?: { note?: unknown } | null } } | null)
    ?.governance?.freeze;
  return freeze && typeof freeze.note === 'string' ? freeze.note : APPROVAL_INSTRUCTIONS;
}

/** S46 (B): the governance fields of a proposing tool's arguments, for the engine. */
function governanceOf(args: { ticket?: string; justification?: string }): {
  ticket?: string;
  justification?: string;
} {
  return { ticket: args.ticket, justification: args.justification };
}

const REF_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const REF_TOKEN_RE = /^@\{([A-Za-z][A-Za-z0-9_]*)\.id\}$/;

/**
 * Grammar/shape validation for a multi-step plan. Semantics (FLS, required
 * fields, validation rules) are the ORG's to judge at execute — with
 * all_or_none defaulting true, an org refusal rolls back cleanly and spends
 * the code, same as a flat failure. What must be exact here is the reference
 * grammar: a token that survives to the org malformed gets "substituted" into
 * garbage, and the preview would have lied about what gets written.
 * Returns an error message, or null when the plan is well-formed.
 */
function validateDmlPlan(args: {
  operation?: string;
  object?: string;
  records?: unknown[];
  ids?: unknown[];
  steps?: Array<{
    ref?: string;
    operation: 'insert' | 'update' | 'delete';
    object: string;
    record?: Record<string, unknown>;
    id?: string;
  }>;
}): string | null {
  if (args.operation || args.object || args.records || args.ids) {
    return 'Send either steps (a plan) or the flat operation/object fields — not both.';
  }
  const steps = args.steps ?? [];
  // Tokens may only cite EXPLICIT refs of EARLIER INSERT steps: inserts are
  // the only steps whose composite response carries an id (update/delete
  // return 204 with no body), and forward/self references can never resolve.
  const insertRefsSoFar = new Set<string>();
  const allRefs = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const where = `step ${i + 1}`;
    if (!/^[A-Za-z0-9_]+$/.test(step.object)) return `${where}: invalid object API name`;
    if (/__mdt$/i.test(step.object)) {
      return (
        `${where}: ${step.object} is a custom metadata type — its records are METADATA, ` +
        `not data, and the REST API cannot write them. Deploy the record instead: ` +
        `validate_deploy with type CustomMetadata, api_name "<Type>.<Record>" ` +
        `(type name without __mdt).`
      );
    }
    if (step.ref !== undefined) {
      if (!REF_RE.test(step.ref)) return `${where}: invalid ref "${step.ref}" (letters/digits/_, start with a letter)`;
      if (allRefs.has(step.ref)) return `${where}: duplicate ref "${step.ref}"`;
      allRefs.add(step.ref);
    }
    const checkToken = (value: string, slot: string): string | null => {
      const m = REF_TOKEN_RE.exec(value);
      if (!m) return `${where}: ${slot} contains "@{" but is not a whole-value "@{ref.id}" token`;
      if (!insertRefsSoFar.has(m[1]!)) {
        return `${where}: ${slot} references "@{${m[1]}.id}" which is not an EARLIER insert step's ref`;
      }
      return null;
    };

    if (step.operation === 'insert') {
      if (!step.record || Object.keys(step.record).length === 0) return `${where}: insert requires record`;
      if (step.id !== undefined) return `${where}: insert must not carry id`;
    } else {
      if (step.id === undefined) return `${where}: ${step.operation} requires id (a record id or "@{ref.id}")`;
      if (!ID_RE.test(step.id)) {
        const bad = checkToken(step.id, 'id');
        if (bad) return bad;
      }
      if (step.operation === 'update' && (!step.record || Object.keys(step.record).length === 0)) {
        return `${where}: update requires record`;
      }
      if (step.operation === 'delete' && step.record !== undefined) {
        return `${where}: delete must not carry record`;
      }
    }

    for (const [key, value] of Object.entries(step.record ?? {})) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) return `${where}: invalid field name "${key}"`;
      // Salesforce rejects Id inside a PATCH body — the target lives in `id`.
      if (key.toLowerCase() === 'id') return `${where}: never put Id inside record — the target goes in the id slot`;
      if (typeof value === 'string' && /@\{/.test(value)) {
        const bad = checkToken(value, `field "${key}"`);
        if (bad) return bad;
      }
    }

    if (step.operation === 'insert' && step.ref) insertRefsSoFar.add(step.ref);
  }
  return null;
}

export function registerDeployTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit, deploys, config, remoteControl } = deps;

  function requireConnection(ref: string, tool: string): ConnectionRecord {
    const rec = db.resolveConnection(ref);
    if (!rec) throw new ConnectionNotFoundError(ref);
    assertGrant(rec, tool, audit);
    return rec;
  }

  server.registerTool(
    'validate_deploy',
    {
      title: 'Validate a metadata deploy (checkOnly)',
      description:
        'Build a deploy package and validate it against the org with checkOnly=true — ' +
        'nothing is committed. Returns the change summary (destructive changes flagged), ' +
        'validation/test results, and blast radius; puts a confirmation code on the ' +
        'human-only approval page. Mid-build check? Pass dry_run: true — same validation, ' +
        'NO approval request or code is created. Normally OMIT test_level: the org applies ' +
        'its own default. An in-progress result means call validate_deploy again to check ' +
        'on it. ' +
        'Large sources (flows especially)? Pass content_file: a file is read byte-exactly. ' +
        "Live diff (real validations only, never dry_run): Contrail retrieves the org's " +
        'CURRENT version of every component and deletion, and the approval page diffs each ' +
        'changed component against that live version, per file for bundles — the diff ' +
        'baseline is the org at validate time. A component the org has but your snapshot ' +
        'lacks is flagged EXISTS IN TARGET (this deploy overwrites it: MODIFY), one your ' +
        'snapshot has but the org lacks NOT IN TARGET, and one whose last-modified stamp in ' +
        "the org differs from your snapshot's CHANGED IN TARGET. When that retrieve fails or " +
        'times out, the page says the org was not re-read and falls back to your local ' +
        'snapshot; types whose bytes cannot be compared (such as Profile) are diffed against ' +
        'the snapshot and labelled so. The pre-images and their last-modified stamps are ' +
        'frozen on the request: execute_deploy re-checks the stamps before running, and the ' +
        'restorable bytes become its revert package. ' +
        "Policies: the human's config.json can set rules (list_connections reports them). A " +
        'real validation that breaks one is refused, naming the rule, and replaces no pending ' +
        'code: relay it to the human and never try another route. During a freeze the request ' +
        'is created, but while it lasts the human must type an emergency reason on their ' +
        'approval surface to release it. dry_run reports what a real validation would be ' +
        'refused for (policy_check) without refusing.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id) — name it unmissably to the human.'),
        components: z
          .array(
            z.object({
              type: z
                .string()
                .describe(
                  'ApexClass, ApexTrigger, ApexPage, Flow, CustomObject, PermissionSet, ' +
                    'CustomTab, FlexiPage, CustomApplication, ReportType, GlobalValueSet, ' +
                    'ConnectedApp, NamedCredential / ExternalCredential / AuthProvider ' +
                    '(credential metadata NEVER carries working secrets: per-principal ' +
                    'values are entered in Setup after deploy, retrieves return ' +
                    'placeholders, and principals need externalCredentialPrincipalAccesses ' +
                    'on a permission set), PlatformEventChannel(Member), ' +
                    'ManagedEventSubscription, Layout, CustomMetadata (records, dotted ' +
                    'Type.Record names), LeadConvertSettings (SINGLETON — api_name is ' +
                    'literally "LeadConvertSettings"; a modify replaces ALL lead field ' +
                    'mappings, retrieve-first), Report / Dashboard (folder-qualified ' +
                    '"FolderDevName/Name" api_names; deploy the ReportFolder/DashboardFolder ' +
                    'component first or in the same package for a new folder), ' +
                    'ReportFolder / DashboardFolder (content = the whole <ReportFolder> doc ' +
                    'with folderShares — folder sharing is what makes reports visible), ' +
                    'Agentforce types Bot, GenAiPlugin (agent topics — modifying one on an ' +
                    'ACTIVE agent needs the human to deactivate it first), ' +
                    'GenAiPromptTemplate (activeVersionIdentifier is org-generated: ' +
                    'retrieve-first, never hand-type it), GenAiPromptTemplateActv, ' +
                    'AiEvaluationDefinition (legacy Testing Center test definitions), ' +
                    'AiTestingDefinition (Agentforce Studio Tests-tab suites — Salesforce marks ' +
                    'the type and its runner BETA; a deploy stores the suite and runs nothing — ' +
                    'run_agent_eval runs it (on the org probed a deployed suite appeared in the Tests ' +
                    'tab only after its first run); a modify replaces the whole ' +
                    'suite), AiAgentScorerDefinition (custom scorers; versions are APPEND-ONLY ' +
                    'org-side — retrieve-first and carry every version forward; a ' +
                    'GenAiPromptTemplate it engines on may ship in the same package — ' +
                    'package.xml lists the template first), BotTemplate, ' +
                    'BotBlock, CustomPermission (pairs with a customPermissions grant on a ' +
                    'permission set — ungranted it does nothing), PermissionSetGroup ' +
                    '(members DETACH if omitted on modify; the org recalculates grants ' +
                    'ASYNCHRONOUSLY after deploy — verify Status via soql_query), ' +
                    'MutingPermissionSet (a muted permission omitted on modify is UN-MUTED ' +
                    '— silently restored to every assigned user), QuickAction (object ' +
                    'actions dotted "Account.New_X", global actions bare; surfaced by page ' +
                    'layouts, global publisher layouts, or Lightning record pages with ' +
                    'dynamic actions — never by the deploy itself), OmniDataTransform ' +
                    '(Omnistudio Data Mappers; content = the whole <OmniDataTransform> ' +
                    'document; api_name <Name>_<version>, letters and digits — the exact ' +
                    'fullName rule is not yet confirmed; per Salesforce Help the Metadata API ' +
                    "deploys them only where the org's Omnistudio Metadata setting is on; " +
                    'deploy them apart from setup metadata), or child types CustomField / ' +
                    'ValidationRule / CustomLabel / ListView / RecordType / BotVersion ' +
                    '(dotted MyBot.v1). ' +
                    'Bundle types GenAiFunction / GenAiPlannerBundle / AiAuthoringBundle / ' +
                    'LightningComponentBundle / AuraDefinitionBundle (one component = a ' +
                    'directory of files) take a ' +
                    'Contrail bundle ENVELOPE as content: JSON {"contrail_bundle":1, ' +
                    '"files": {"<relative path>": "<body>", ...}} — the file set ' +
                    "retrieve_metadata's bundle_files listing shows, main file included " +
                    '(e.g. "My_Fn.genAiFunction-meta.xml"). LightningComponentBundle (LWC) ' +
                    'requires <Name>.js + <Name>.js-meta.xml; .html/.css/.svg and ' +
                    'subdirectories (e.g. secondary templates) are normal, __tests__ and ' +
                    'dot-files never deploy, and the org compiles on deploy. ' +
                    'AuraDefinitionBundle is FLAT (no subfolders), every file ' +
                    '<Name>-prefixed, exactly ONE primary (<Name>.cmp|.app|.evt|.intf|' +
                    '.tokens) plus its required <Name>.<kind>-meta.xml (pins apiVersion); ' +
                    'secondaries are <Name>Controller/Helper/Renderer.js, .css, .design ' +
                    '(.cmp only), .svg, .auradoc; namespace-free names only. Refresh the ' +
                    'snapshot before modifying an org-existing bundle — the whole directory ' +
                    'is replaced (files the envelope omits are DELETED org-side). ' +
                    'AiAuthoringBundle deploys as a DRAFT ' +
                    'STAGE: exactly <Name>.agent (plaintext Agent Script) + ' +
                    '<Name>.bundle-meta.xml; nothing compiles and the running agent is ' +
                    'unchanged until a human publishes the draft. Agent publish/preview ' +
                    'stay human; activate/deactivate goes through ' +
                    'agent_activation_propose/execute (its own ritual), and agent test runs ' +
                    '(Testing Center or Studio) through run_agent_eval.',
                ),
              api_name: z.string().describe('Full API name; children dotted (Account.MyField__c).'),
              content: z
                .string()
                .optional()
                .describe(
                  'Full source for file types; for child types, the XML block exactly as ' +
                    'retrieve_metadata returns it (e.g. <fields>…</fields>). Exactly one of ' +
                    'content or content_file is required.',
                ),
              content_file: z
                .string()
                .optional()
                .describe(
                  'Absolute path to a file holding the source, read byte-exactly instead of ' +
                    'content. PREFER THIS for large components (flows especially): retyping ' +
                    'tens of KB of XML risks a silent one-character corruption. Author the ' +
                    'file under ' +
                    `Contrail's staging directory FROM THE START — ${stagingDir()} — because ` +
                    'the session working folder is NOT a deploy source root. Also accepted: ' +
                    "under Contrail's snapshots directory, or under a directory the human " +
                    'already listed in deploy.allowedSourceRoots. Anywhere else is refused — ' +
                    'copy the file into staging and retry; never ask the human to change ' +
                    'config for a one-off. Read at validation time and frozen into the ' +
                    'approved package, so editing the file afterwards cannot change what ' +
                    'gets deployed.',
                ),
            }),
          )
          .max(50)
          .optional()
          .describe('Components to create or update.'),
        destructive: z
          .array(z.object({ type: z.string(), api_name: z.string() }))
          .max(50)
          .optional()
          .describe('Components to DELETE. Deletions are destructive and flagged prominently.'),
        allow_unregistered_delete: z
          .boolean()
          .optional()
          .describe(
            'Required true to delete a component of a type Contrail cannot read — such a ' +
              'delete is BLIND (no content, no dependent listing) and the approval page ' +
              'says so. Translation types are refused regardless (Setup / per-entry ' +
              'Tooling are their routes).',
          ),
        test_level: z
          .enum(['NoTestRun', 'RunLocalTests', 'RunSpecifiedTests', 'RunAllTestsInOrg'])
          .optional()
          .describe(
            "OMIT unless you have a reason: the org then applies its own default — " +
              'sandboxes run no tests; production runs local tests when the package ' +
              'carries Apex and none otherwise. Production REFUSES an explicit ' +
              'NoTestRun, so never send it there (a no-Apex prod deploy just omits ' +
              'this). RunSpecifiedTests needs run_tests.',
          ),
        run_tests: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Test classes for RunSpecifiedTests.'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'true = SILENT org-side validation for mid-build checks: full results ' +
              '(errors, warnings, permission coverage, tests), but NO approval request, ' +
              'code, or page is created, nothing becomes executable, and a pending ' +
              'approval on this connection is left untouched (a normal validate ' +
              'supersedes it). Use freely while iterating; the FINAL validate omits it ' +
              'so the human sees exactly one meaningful approval.',
          ),
        job_id: z
          .string()
          .optional()
          .describe(
            'Poll a RUNNING validation by the job_id an earlier call returned — pass ' +
              '{connection, job_id} ALONE; nothing is re-sent and no content_file is ' +
              're-read. Jobs are keyed by their input, so a poll only ever returns the ' +
              'result of the exact validation it names (re-sending identical full ' +
              'arguments attaches to the same job too).',
          ),
        ticket: z.string().max(120).optional().describe(TICKET_PARAM),
        justification: z.string().max(1000).optional().describe(JUSTIFICATION_PARAM),
      },
    },
    async (args: {
      connection: string;
      components?: Array<{
        type: string;
        api_name: string;
        content?: string;
        content_file?: string;
      }>;
      destructive?: Array<{ type: string; api_name: string }>;
      test_level?: TestLevel;
      run_tests?: string[];
      dry_run?: boolean;
      job_id?: string;
      allow_unregistered_delete?: boolean;
      ticket?: string;
      justification?: string;
    }, extra) =>
      // S43: sample the Remote Control state at call start (the hook has just
      // reported); the mint, minutes later, reads that sample.
      remoteControl.run(extra, 'validate_deploy', () =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'validate_deploy');
        if (args.job_id !== undefined) {
          // STRICT: any other argument beside job_id is refused, not ignored —
          // a silently dropped test_level/dry_run would let the caller believe
          // an option applied to a job whose identity already fixed it.
          if (
            args.components?.length ||
            args.destructive?.length ||
            args.test_level !== undefined ||
            args.run_tests !== undefined ||
            args.dry_run !== undefined ||
            args.allow_unregistered_delete !== undefined ||
            args.ticket !== undefined ||
            args.justification !== undefined
          ) {
            return fail(
              'Pass job_id ALONE to poll a running validation — or the full arguments ' +
                '(without job_id) to start one. A poll cannot change the job\'s options: ' +
                'they are part of its identity.',
            );
          }
          const polled = await deploys.pollValidate(conn, args.job_id);
          if (!polled) {
            return fail(
              `No running or uncollected validation job "${args.job_id}" on "${conn.alias}" — ` +
                'its result may already have been collected. Re-send the full arguments ' +
                'to validate again.',
            );
          }
          return renderValidateOutcome(polled, conn);
        }
        // Resolve file-backed components to bytes BEFORE anything else: the
        // package is built and frozen from what we read here, so this is the
        // single point where "what will be deployed" is decided.
        const components = (args.components ?? []).map((c) => {
          const hasInline = typeof c.content === 'string';
          if (hasInline && c.content_file) {
            throw new Error(
              `${c.type} ${c.api_name}: pass content OR content_file, not both — ` +
                'Contrail will not guess which one you meant to deploy.',
            );
          }
          if (!hasInline && !c.content_file) {
            throw new Error(
              `${c.type} ${c.api_name}: needs content or content_file. For large ` +
                `components write the source under ${stagingDir()} and pass content_file.`,
            );
          }
          if (c.content_file) {
            const src = resolveSourceFile(c.content_file, config.deploy.allowedSourceRoots);
            return {
              type: c.type,
              api_name: c.api_name,
              content: src.content,
              source_path: src.sourcePath,
              source_sha256: src.sourceSha256,
            };
          }
          return { type: c.type, api_name: c.api_name, content: c.content as string };
        });
        const destructive = args.destructive ?? [];
        if (components.length + destructive.length === 0) {
          return fail('Provide at least one component or destructive entry.');
        }
        const badLevel = testLevelRefusal(args, conn);
        if (badLevel) return fail(badLevel);
        const outcome = await deploys.validateDeploy(conn, {
          components,
          destructive,
          // Unspecified stays unspecified all the way to the SOAP call — the
          // org's default behavior is the only choice production accepts for
          // a no-Apex package (it rejects an explicit NoTestRun).
          testLevel: args.test_level,
          runTests: args.run_tests ?? [],
          dryRun: args.dry_run === true,
          allowUnregisteredDelete: args.allow_unregistered_delete === true,
          ...governanceOf(args),
          viaTool: 'validate_deploy',
        });
        return renderValidateOutcome(outcome, conn);
      })),
  );

  /**
   * One rendering for submitted AND polled validations. Every label derives
   * from the RESULT (request_id) or the job id's own dry/real prefix, never
   * from the caller's arguments — a poll carries no arguments at all.
   */
  function renderValidateOutcome(
    outcome: Awaited<ReturnType<typeof deploys.validateDeploy>>,
    conn: ConnectionRecord,
  ) {
    const isDry = outcome.job_id.startsWith('vdry-');
    switch (outcome.status) {
      case 'in_progress':
        return ok(
          { job_id: outcome.job_id, progress: outcome.progress, started_at: outcome.started_at },
          `Validation is still running — poll with {connection, job_id: "${outcome.job_id}"} ` +
            '(or re-send the same full arguments, which attaches to this same job). ' +
            'ticket and justification are part of that identity — a reworded justification ' +
            "starts a second validation, and any code it issues replaces this one's; poll with " +
            'job_id.',
        );
      case 'failed':
        // S46 (B): a policy refusal made when the validation finished is
        // returned bare, like the one made before it started.
        if (outcome.error.startsWith('POLICY ')) return fail(outcome.error);
        return fail(`Validation errored (job ${outcome.job_id}): ${outcome.error}`);
      case 'complete': {
        const r = outcome.result;
        if (!r.validation_passed) {
          return ok(
            { ...(r.failure ?? {}), job_id: outcome.job_id },
            isDry
              ? 'Dry run: validation FAILED.'
              : 'Validation FAILED — no confirmation code was issued.',
          );
        }
        // Label from the RESULT, not the caller's args: a dry run is
        // whatever the engine actually produced (request_id null), so a
        // mislabel is impossible even if job attachment ever regresses.
        if (r.summary?.request_id === null) {
          return ok(
            { ...r.summary, dry_run: true, job_id: outcome.job_id },
            'DRY RUN passed — no approval request or code exists, and nothing can be ' +
              'executed from this through Contrail. When the package is final, ' +
              'validate again without dry_run to propose it for approval.',
          );
        }
        return ok(
          { ...r.summary, job_id: outcome.job_id, approval_page: r.approval },
          `Validation passed. TARGET: ${conn.alias} (${conn.orgType}). ${closingInstructions(r.summary)}`,
        );
      }
    }
  }

  server.registerTool(
    'deactivate_flow',
    {
      title: 'Deactivate a flow',
      description:
        'Deactivate a flow (turn off its active version) — to switch off automation, or as the ' +
        'first step before trying to delete a flow. Routes through the same two-step approval as ' +
        'any write: this validates the change and opens the approval page; the human reads the ' +
        'code back to execute_deploy. Note: deleting a flow via the Metadata API is unreliable ' +
        'even after deactivation ("insufficient access rights on cross-reference id"); if a ' +
        'destructive delete fails, delete the flow in Setup → Flows. ' +
        POLICY_NOTE,
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        flow: z.string().describe('Flow API name (DeveloperName).'),
        test_level: z
          .enum(['NoTestRun', 'RunLocalTests', 'RunSpecifiedTests', 'RunAllTestsInOrg'])
          .optional()
          .describe(
            'Only when a policy on this connection sets a minimum test level ' +
              '(list_connections reports it): pass that level or a stricter one. Otherwise ' +
              'OMIT it — the org then applies its own default. RunSpecifiedTests needs ' +
              'run_tests.',
          ),
        run_tests: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Test classes for RunSpecifiedTests.'),
        ticket: z.string().max(120).optional().describe(TICKET_PARAM),
        justification: z.string().max(1000).optional().describe(JUSTIFICATION_PARAM),
      },
    },
    async (args: {
      connection: string;
      flow: string;
      test_level?: TestLevel;
      run_tests?: string[];
      ticket?: string;
      justification?: string;
    }, extra) =>
      // S43: deactivate_flow mints a code through validateDeploy — same gate.
      remoteControl.run(extra, 'deactivate_flow', () =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'deactivate_flow');
        if (!/^[A-Za-z0-9_]+$/.test(args.flow)) return fail('invalid flow API name');
        const badLevel = testLevelRefusal(args, conn);
        if (badLevel) return fail(badLevel);
        const outcome = await deploys.validateDeploy(conn, {
          components: [
            { type: 'FlowDefinition', api_name: args.flow, content: flowDeactivationXml() },
          ],
          destructive: [],
          // Omitted unless a policy asks for one: an explicit NoTestRun would
          // make production refuse to deactivate a flow at all; omitted, the
          // org waves a no-Apex package through everywhere.
          testLevel: args.test_level,
          runTests: args.run_tests ?? [],
          ...governanceOf(args),
          viaTool: 'deactivate_flow',
        });
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { job_id: outcome.job_id, progress: outcome.progress, started_at: outcome.started_at },
              `Still validating (job ${outcome.job_id}) — check on it with validate_deploy ` +
                `{connection, job_id: "${outcome.job_id}"}, or call deactivate_flow again with ` +
                'EXACTLY the same arguments. ticket, justification and test_level are part of ' +
                "the job's identity: a call that changes any of them, a reworded justification " +
                'included, starts a second validation, and any code it issues replaces this ' +
                "one's.",
            );
          case 'failed':
            // S46 (B): a policy refusal made when the validation finished is returned bare.
            if (outcome.error.startsWith('POLICY ')) return fail(outcome.error);
            return fail(`Deactivation validation errored: ${outcome.error}`);
          case 'complete': {
            const r = outcome.result;
            if (!r.validation_passed) {
              return ok(r.failure ?? {}, 'Validation FAILED — no confirmation code was issued.');
            }
            // S46 (B): the execute pointer follows the approval instructions
            // only — a frozen request's note tells the agent to wait.
            const closing = closingInstructions(r.summary);
            return ok(
              { ...r.summary, approval_page: r.approval },
              `Deactivation of flow "${args.flow}" validated. TARGET: ${conn.alias} ` +
                `(${conn.orgType}). ${closing}` +
                (closing === APPROVAL_INSTRUCTIONS ? ' Execute it with execute_deploy.' : ''),
            );
          }
        }
      })),
  );

  server.registerTool(
    'execute_deploy',
    {
      title: 'Execute a validated deploy',
      description:
        'Execute the deploy that the given confirmation code approves. Contrail gives the ' +
        'code only to the human (their approval page, and their phone if they set that up): ' +
        'never guess, never fabricate, never reuse one — only pass a code the human just ' +
        'gave you. Codes are single-use, expire in ~1h, and are ' +
        'invalidated by any new REAL validation on the same connection (a dry_run ' +
        'check leaves them untouched). ' +
        'Target check: before claiming the code, Contrail re-reads the last-modified stamps of ' +
        "the package's members and compares them — not bytes — with the validate-time " +
        'baseline; if a member changed, appeared or disappeared, nothing is deployed, the code ' +
        'is voided, and the call reports TARGET MOVED naming what moved — re-validate for a ' +
        'fresh code. The check covers changes up to the moment the code is claimed only; a ' +
        "member it cannot compare is reported as unchecked on the result's target_check, never " +
        'refused; and when the org cannot be re-read at all, the deploy still runs and ' +
        'target_check says the check did not happen. ' +
        "Revert package: on success the result's revert_package points at the pre-images " +
        'Contrail retrieved when this deploy was VALIDATED (not just before executing); it is ' +
        'kept, marked outcome unknown, when Contrail loses track of a deploy that may have ' +
        'committed, and is null with a revert_note saying why when there is no live pre-image ' +
        'to restore from. Contrail never deploys a revert on its own — a revert is its own ' +
        'validate_deploy. ' +
        'Snapshot re-baseline: after a successful deploy Contrail re-reads the deployed ' +
        "components into the local snapshot and reports it on the result's snapshot block — " +
        'status complete, partial, none, unavailable, disabled or pending, with each skipped ' +
        "component's reason — so refresh_snapshot is needed only for what that block says was " +
        'not updated. Best-effort and bounded: it never fails the deploy, covers only the ' +
        "deploy's own components, and does not re-query the org-computed dependency data.",
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'execute_deploy');
        const outcome = await deploys.executeDeploy(conn, args.confirmation_code);
        switch (outcome.status) {
          case 'in_progress':
            // S46 (C): the deploy has committed; only the snapshot re-read runs.
            if (outcome.progress === REBASELINE_PROGRESS) {
              return ok(
                { progress: outcome.progress, started_at: outcome.started_at },
                'The deploy has completed in the org; Contrail is still re-reading the deployed ' +
                  'components into the local snapshot. Call execute_deploy again with the same ' +
                  'connection and code to collect the result.',
              );
            }
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Deploy is still running — call execute_deploy again with the same connection ' +
                'and code to check on it.',
            );
          case 'failed':
            return fail(`Deploy errored: ${outcome.error}`);
          case 'complete':
            return ok(outcome.result);
        }
      }),
  );

  server.registerTool(
    'dml_propose',
    {
      title: 'Propose a data change (two-step)',
      description:
        'Stage a data change with a before/after preview. Nothing touches the org until the ' +
        'human reads the confirmation code from the approval page and you pass it to ' +
        'dml_execute. TWO SHAPES: (a) flat — one operation on one object, max 200 rows, ' +
        'all-or-none; (b) a PLAN — 2–25 ordered steps, one record each, where a later step ' +
        'references an earlier INSERT step\'s created id with the whole-value token ' +
        '"@{ref.id}" (in field values, or as the id of an update/delete). Use a plan to seed ' +
        'linked test data in ONE approval: e.g. insert Account (ref "acct") → insert Contact ' +
        '{AccountId: "@{acct.id}"} → … → update "@{opp.id}". The org resolves the tokens ' +
        'server-side. all_or_none (default true) rolls the whole plan back on any failure; ' +
        'false keeps successful steps and fails only dependents — the approval page states ' +
        'which mode the human is approving. ' +
        POLICY_NOTE,
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        operation: z
          .enum(['insert', 'update', 'delete'])
          .optional()
          .describe('Flat shape only. Omit when sending steps.'),
        object: z
          .string()
          .optional()
          .describe('Flat shape only: SObject API name, e.g. Account or Invoice__c.'),
        records: z
          .array(z.record(z.unknown()))
          .max(200)
          .optional()
          .describe('Flat insert/update: field maps (update rows must include Id).'),
        ids: z
          .array(z.string())
          .max(200)
          .optional()
          .describe('Flat delete: record ids.'),
        steps: z
          .array(
            z.object({
              ref: z
                .string()
                .max(40)
                .optional()
                .describe('Handle for this step\'s created id; letters/digits/_, must start with a letter.'),
              operation: z.enum(['insert', 'update', 'delete']),
              object: z.string(),
              record: z
                .record(z.unknown())
                .optional()
                .describe('insert/update: the field map. Never include Id — the target goes in `id`.'),
              id: z
                .string()
                .optional()
                .describe('update/delete: a literal record id or "@{ref.id}".'),
            }),
          )
          .min(2)
          .max(25)
          .optional()
          .describe('Plan shape: ordered steps, one record each. Mutually exclusive with operation/object.'),
        all_or_none: z
          .boolean()
          .optional()
          .describe('Plan shape: default true (atomic). false = keep successes, fail dependents.'),
        ticket: z.string().max(120).optional().describe(TICKET_PARAM),
        justification: z.string().max(1000).optional().describe(JUSTIFICATION_PARAM),
      },
    },
    async (args: {
      connection: string;
      operation?: 'insert' | 'update' | 'delete';
      object?: string;
      records?: Array<Record<string, unknown>>;
      ids?: string[];
      steps?: Array<{
        ref?: string;
        operation: 'insert' | 'update' | 'delete';
        object: string;
        record?: Record<string, unknown>;
        id?: string;
      }>;
      all_or_none?: boolean;
      ticket?: string;
      justification?: string;
    }, extra) =>
      remoteControl.run(extra, 'dml_propose', () =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'dml_propose');

        if (args.steps) {
          const bad = validateDmlPlan(args);
          if (bad) return fail(bad);
          const preview = await deploys.proposeDml(
            conn,
            {
              plan: true,
              version: 2,
              all_or_none: args.all_or_none ?? true,
              steps: args.steps,
            },
            governanceOf(args),
          );
          return ok(
            preview,
            `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${closingInstructions(preview)}`,
          );
        }

        if (args.all_or_none !== undefined) {
          return fail('all_or_none applies only to plans (steps) — the flat shape is always all-or-none.');
        }
        if (!args.operation || !args.object) {
          return fail('Provide either steps (a plan) or operation + object (flat).');
        }
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        if (/__mdt$/i.test(args.object)) {
          return fail(
            `${args.object} is a custom metadata type — its records are METADATA, not ` +
              `data, and the REST API cannot write them. Deploy the record instead: ` +
              `validate_deploy with type CustomMetadata, api_name "<Type>.<Record>" ` +
              `(type name without __mdt).`,
          );
        }
        if (args.operation === 'delete') {
          if (!args.ids?.length) return fail('delete requires ids.');
          if (args.ids.some((i) => !ID_RE.test(i))) return fail('invalid record id in ids.');
        } else {
          if (!args.records?.length) return fail(`${args.operation} requires records.`);
          for (const r of args.records) {
            for (const key of Object.keys(r)) {
              if (!/^[A-Za-z0-9_]+$/.test(key)) return fail(`invalid field name "${key}"`);
            }
            for (const v of Object.values(r)) {
              if (typeof v === 'string' && /@\{/.test(v)) {
                return fail('reference tokens ("@{ref.id}") are only valid inside a plan (steps).');
              }
            }
            if (args.operation === 'update' && !ID_RE.test(String(r.Id ?? r.id ?? ''))) {
              return fail('every update record needs a valid Id.');
            }
          }
        }
        const preview = await deploys.proposeDml(
          conn,
          {
            operation: args.operation,
            object: args.object,
            records: args.records,
            ids: args.ids,
          },
          governanceOf(args),
        );
        return ok(
          preview,
          `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${closingInstructions(preview)}`,
        );
      })),
  );

  server.registerTool(
    'dml_execute',
    {
      title: 'Execute a proposed data change',
      description:
        'Execute the DML that the given confirmation code approves. Contrail gives the code ' +
        'only to the human (their approval page, and their phone if they set that up) — only ' +
        'pass a code the human just gave you. Single-use, ' +
        '~1h expiry, invalidated by a new proposal on the same connection. ' +
        'Target check: before claiming the code, Contrail re-runs the preview query and ' +
        "compares what it returns with what the approval showed — each updated field's " +
        'before-value, and that each approved record still comes back; if a value changed or a ' +
        'record is no longer returned, nothing is written, the code is voided, and the call ' +
        'reports TARGET MOVED naming the records — re-run dml_propose for a fresh code. The ' +
        'check covers changes up to the moment the code is claimed, not changes landing while ' +
        'the org processes the write, and a value changed and changed back is invisible to it; ' +
        "a record the preview did not return or whose pre-check failed is reported as unchecked " +
        "on the result's target_check, never refused; one for which the approval showed no " +
        'before-value is also reported as unchecked, but its existence is still re-checked, so ' +
        'a record no longer returned is TARGET MOVED; an insert has nothing to re-check; when ' +
        'the org cannot be re-read at all, the write still runs and target_check ' +
        'says the check did not happen.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'dml_execute');
        const result = await deploys.executeDml(conn, args.confirmation_code);
        return ok(result);
      }),
  );

  server.registerTool(
    'apex_propose',
    {
      title: 'Propose an anonymous Apex script (two-step)',
      description:
        'Stage an anonymous Apex script for human approval. This is the ONLY path to ' +
        'executeAnonymous: nothing runs until the human reads the confirmation code from ' +
        'the approval page (which shows the script verbatim) and you pass it to ' +
        "apex_execute. The script runs with the HUMAN's permissions and can touch anything " +
        'their user can; DML it performs COMMITS on success, and an uncaught exception ' +
        'rolls the whole script back. There is no dry-run — the org compiles and executes ' +
        'in one shot at execute, and a compile error spends the code like any failed ' +
        'write. Max 32,000 chars (executeAnonymous is a URL-encoded GET); split longer ' +
        'work into multiple proposals. The script returns no output — write System.debug ' +
        'and set a trace flag first (set_trace_flag) if you need to see the log. ' +
        POLICY_NOTE,
      inputSchema: {
        connection: z
          .string()
          .describe('Target connection alias (or id) — name it unmissably to the human.'),
        code: z
          .string()
          .min(1)
          .max(32_000)
          .describe('The anonymous Apex source, verbatim (this is the script, NOT a confirmation code).'),
        ticket: z.string().max(120).optional().describe(TICKET_PARAM),
        justification: z.string().max(1000).optional().describe(JUSTIFICATION_PARAM),
      },
    },
    async (
      args: { connection: string; code: string; ticket?: string; justification?: string },
      extra,
    ) =>
      remoteControl.run(extra, 'apex_propose', () =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'apex_propose');
        if (args.code.trim().length === 0) return fail('The script is empty.');
        const preview = await deploys.proposeApex(conn, args.code, governanceOf(args));
        return ok(
          preview,
          `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${closingInstructions(preview)}`,
        );
      })),
  );

  server.registerTool(
    'apex_execute',
    {
      title: 'Execute a proposed anonymous Apex script',
      description:
        'Execute the anonymous Apex that the given confirmation code approves. Contrail ' +
        'gives the code only to the human (their approval page, and their phone if they set ' +
        'that up) — only pass a code the human just gave you. Single-use, ~1h expiry, ' +
        'invalidated by a new apex_propose on the same ' +
        'connection. On success the script\'s DML is committed; compile and runtime ' +
        'errors are returned honestly and spend the code.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'apex_execute');
        const result = await deploys.executeApex(conn, args.confirmation_code);
        return ok(result);
      }),
  );

  server.registerTool(
    'agent_activation_propose',
    {
      title: 'Propose an agent activation change (two-step)',
      description:
        'Stage activating or deactivating a PUBLISHED Agentforce agent version behind ' +
        'the approval ritual. This changes LIVE behavior immediately on execute — no ' +
        'draft in between — so nothing happens until the human reads the confirmation ' +
        'code from the approval page and you pass it to agent_activation_execute. The ' +
        'BotVersion is resolved and its current status frozen at propose; a version ' +
        'already in the requested state is refused without burning an approval. Only ' +
        'published versions can flip (the org refuses drafts, verbatim in messages[]). ' +
        'Publishing/compiling Agent Script is NOT this tool — that stays human. ' +
        POLICY_NOTE,
      inputSchema: {
        connection: z
          .string()
          .describe('Target connection alias (or id) — name it unmissably to the human.'),
        agent: z
          .string()
          .describe("The agent's Bot DeveloperName (soql_query BotDefinition to enumerate)."),
        version: z
          .string()
          .describe("The BotVersion DeveloperName, e.g. 'v2'."),
        status: z
          .enum(['Active', 'Inactive'])
          .describe('The state to put the version in.'),
        ticket: z.string().max(120).optional().describe(TICKET_PARAM),
        justification: z.string().max(1000).optional().describe(JUSTIFICATION_PARAM),
      },
    },
    async (args: {
      connection: string;
      agent: string;
      version: string;
      status: 'Active' | 'Inactive';
      ticket?: string;
      justification?: string;
    }, extra) =>
      remoteControl.run(extra, 'agent_activation_propose', () =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'agent_activation_propose');
        const preview = await deploys.proposeActivation(
          conn,
          {
            agent: args.agent,
            version: args.version,
            status: args.status,
          },
          governanceOf(args),
        );
        if (preview.proposed !== true) return ok(preview);
        return ok(
          preview,
          `Proposed — nothing changed yet. TARGET: ${conn.alias} (${conn.orgType}). ${closingInstructions(preview)}`,
        );
      })),
  );

  server.registerTool(
    'agent_activation_execute',
    {
      title: 'Execute a proposed agent activation change',
      description:
        'Apply the agent activation change the given confirmation code approves — one ' +
        'documented Connect REST call, then a re-read so the result reports what the org ' +
        'CONFIRMS. Contrail gives the code only to the human (their approval page, and their ' +
        'phone if they set that up) — only pass a code the human just gave you. Single-use, ' +
        '~1h expiry, invalidated by a new ' +
        'agent_activation_propose on the same connection. Changes live agent behavior ' +
        'immediately on success. ' +
        "Target check: before claiming the code, Contrail re-reads the agent version's Status " +
        'and compares it with the status the approval was for; if it changed or the version is ' +
        'no longer returned, nothing is applied, the code is voided, and the call reports TARGET ' +
        'MOVED — re-run agent_activation_propose for a fresh code. The check covers changes up ' +
        'to the moment the code is claimed, not changes landing while the org processes the ' +
        'call; a request with no recorded starting status is reported as unchecked on the ' +
        "result's target_check, never refused; and when the org cannot be re-read at all, the " +
        'change still runs and target_check says the check did not happen.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'agent_activation_execute');
        const result = await deploys.executeActivation(conn, args.confirmation_code);
        return ok(result);
      }),
  );

  server.registerTool(
    'bulk_load_propose',
    {
      title: 'Propose a bulk data load from CSV files (two-step)',
      description:
        'Stage a multi-file Bulk API 2.0 data load behind the approval ritual. Rows go ' +
        'FILE → ORG and never through this conversation: prepare UTF-8, comma-delimited ' +
        "CSVs under Contrail's staging directory (API-name headers; cross-object references " +
        'as relationship-by-external-ID columns like "Account.External_Id__c", resolved ' +
        'org-side), then name one file per step. Steps execute SEQUENTIALLY in the order ' +
        'given — parents before children. Each file is scanned (headers, row count) and ' +
        'FROZEN at propose; the approval page shows every step with counts and hashes, and ' +
        'nothing touches the org until the human reads the confirmation code to ' +
        'bulk_load_execute. Bulk steps are separate org-side jobs with NO cross-job ' +
        'rollback; delete steps are SOFT deletes (Recycle Bin) and their CSV is a single ' +
        'Id column. For small test-data seeding (≤200 rows) prefer dml_propose. ' +
        POLICY_NOTE,
      inputSchema: {
        connection: z
          .string()
          .describe('Target connection alias (or id) — name it unmissably to the human.'),
        steps: z
          .array(
            z.object({
              csv_file: z
                .string()
                .describe(
                  "Absolute path to this step's CSV (or .tsv — a .tsv extension means " +
                    'TAB-delimited, scanned and loaded as such). Same containment as ' +
                    `content_file: under Contrail's staging directory (${stagingDir()} — ` +
                    'stage files there from the start; the session working folder is not ' +
                    'a source root), snapshots, or a configured deploy.allowedSourceRoots ' +
                    'entry. Read and frozen at propose time.',
                ),
              object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
              operation: z.enum(['insert', 'upsert', 'delete']),
              external_id_field: z
                .string()
                .optional()
                .describe(
                  "upsert only (required there): the match field. Pass 'Id' to update by " +
                    'record id. Must be a column in the CSV.',
                ),
            }),
          )
          .min(1)
          .max(config.bulkLoad.maxFilesPerPlan)
          .describe('Ordered steps — one CSV each, executed sequentially.'),
        stop_on_failure: z
          .boolean()
          .optional()
          .describe(
            'Default true: a step with failed rows halts the remaining steps (rows already ' +
              'loaded STAY — bulk has no cross-job rollback). false runs every step.',
          ),
        ticket: z.string().max(120).optional().describe(TICKET_PARAM),
        justification: z.string().max(1000).optional().describe(JUSTIFICATION_PARAM),
      },
    },
    async (args: {
      connection: string;
      steps: Array<{
        csv_file: string;
        object: string;
        operation: 'insert' | 'upsert' | 'delete';
        external_id_field?: string;
      }>;
      stop_on_failure?: boolean;
      ticket?: string;
      justification?: string;
    }, extra) =>
      remoteControl.run(extra, 'bulk_load_propose', () =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'bulk_load_propose');
        const steps = args.steps.map((s) => {
          const { absPath } = resolveSourcePath(s.csv_file, config.deploy.allowedSourceRoots, {
            maxBytes: config.bulkLoad.maxFileBytes,
            noun: 'csv_file',
          });
          return {
            sourcePath: absPath,
            displayName: absPath,
            object: s.object,
            operation: s.operation,
            ...(s.external_id_field ? { externalIdField: s.external_id_field } : {}),
          };
        });
        const preview = await deploys.proposeBulkLoad(
          conn,
          {
            stopOnFailure: args.stop_on_failure ?? true,
            steps,
          },
          governanceOf(args),
        );
        return ok(
          preview,
          `Proposed — nothing loaded. TARGET: ${conn.alias} (${conn.orgType}). ${closingInstructions(preview)}`,
        );
      })),
  );

  server.registerTool(
    'bulk_load_execute',
    {
      title: 'Execute a proposed bulk data load',
      description:
        'Run the bulk load plan that the given confirmation code approves: sequential Bulk ' +
        'API 2.0 ingest jobs from the CSVs frozen at propose. Contrail gives the code only to ' +
        'the human (their approval page, and their phone if they set that up) — only pass a ' +
        'code the human just gave you (single-use, ~1h ' +
        'expiry, invalidated by a new bulk_load_propose on the same connection). Large jobs ' +
        'take minutes: an in-progress result means call bulk_load_execute again with the ' +
        'SAME code to check on it. Successful, failed, and unprocessed rows come back as ' +
        'file paths (never row data) — step-N-success carries the created/updated/deleted ' +
        'record ids; rows loaded by completed steps are never rolled back.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'bulk_load_execute');
        const outcome = await deploys.executeBulkLoad(conn, args.confirmation_code);
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'The bulk load is still running — call bulk_load_execute again with the same ' +
                'connection and code to check on it.',
            );
          case 'failed':
            return fail(`Bulk load errored: ${outcome.error}`);
          case 'complete':
            return ok(outcome.result);
        }
      }),
  );
}
