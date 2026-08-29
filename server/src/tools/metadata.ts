import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError, ContrailError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import { RestClient, stripAttributes } from '../salesforce/rest.js';
import { MetadataSoapClient } from '../salesforce/metadataSoap.js';
import { findChildBlock } from '../snapshot/indexer.js';
import { queryDependencies } from '../deps/graph.js';

/**
 * The P0.2 metadata_read tool surface. Every handler resolves its target
 * connection and passes the layer-2 grant gate before touching anything.
 */

const NAME_RE = /^[A-Za-z0-9_.\- ]+$/;
const TYPE_RE = /^[A-Za-z]+$/;

/**
 * Read budget. The old 60 KB cap was sized for a comfortable tool result, but
 * it silently amputated the artifacts that most need reading whole — a 133 KB
 * flow came back as a fragment, and analysing a fragment of flow XML produces
 * confident wrong answers. Reads are cheap and recoverable; a bad diagnosis is
 * not. So the default now clears a large real flow, an explicit max_bytes
 * raises it to the ceiling, and nothing is ever cut without saying so.
 */
const DEFAULT_CONTENT_BYTES = 250_000;
/** Even an explicit request stops here — one artifact should not eat a context window. */
const MAX_CONTENT_BYTES = 2_000_000;
/** Ceiling across ALL names in one call (names accepts up to 10). */
const CALL_CONTENT_BUDGET = 2_000_000;

/**
 * Types get_org_changes cannot compare directly: children are indexed off
 * their parent file (their listMetadata dates describe the child, the index
 * row describes the parent read), and the labels container is one file.
 */
const ORG_CHANGES_CHILD_TYPES = new Set([
  'CustomField',
  'ValidationRule',
  'CustomLabel',
  'CustomLabels',
  'ListView',
  'RecordType',
]);

/** Container file location + child tag for fragment types. */
const CHILD_SPEC: Record<string, { parentType: string; tag: string }> = {
  CustomField: { parentType: 'CustomObject', tag: 'fields' },
  ValidationRule: { parentType: 'CustomObject', tag: 'validationRules' },
  CustomLabel: { parentType: 'CustomLabels', tag: 'labels' },
  ListView: { parentType: 'CustomObject', tag: 'listViews' },
  RecordType: { parentType: 'CustomObject', tag: 'recordTypes' },
};

export function registerMetadataTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit, config, engine, store, tokenMgr } = deps;

  function requireConnection(ref: string, tool: string): ConnectionRecord {
    const rec = db.resolveConnection(ref);
    if (!rec) throw new ConnectionNotFoundError(ref);
    assertGrant(rec, tool, audit);
    return rec;
  }

  server.registerTool(
    'list_metadata',
    {
      title: 'List metadata inventory',
      description:
        'List indexed metadata for a connection from the local snapshot: all type counts, or ' +
        'the artifacts of one type. Set live=true (with a type) to query the org directly ' +
        'via listMetadata instead of the snapshot.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        type: z
          .string()
          .optional()
          .describe('Metadata type, e.g. ApexClass, Flow, CustomObject, CustomField.'),
        live: z
          .boolean()
          .optional()
          .describe('Query the org directly (requires type). Default: read the local index.'),
      },
    },
    async (args: { connection: string; type?: string; live?: boolean }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'list_metadata');
        if (args.type && !TYPE_RE.test(args.type)) return fail('invalid metadata type');
        if (args.live) {
          if (!args.type) return fail('live=true requires a metadata type.');
          const soap = new MetadataSoapClient(tokenMgr, conn, config.salesforce.apiVersion);
          const props = await soap.listMetadata([args.type]);
          const items = new Map<string, Record<string, unknown>>(
            props.map((p) => [
              p.fullName.toLowerCase(),
              {
                api_name: p.fullName,
                last_modified: p.lastModifiedDate,
                last_modified_by: p.lastModifiedByName,
                source: 'metadata_api',
              },
            ]),
          );
          // Standard/feature-delivered flows are invisible to Metadata API
          // listMetadata AND Tooling FlowDefinition — FlowDefinitionView
          // (regular API) is the only complete inventory. Union it in.
          if (args.type === 'Flow') {
            const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
            try {
              const views = await rest.query<{
                ApiName: string;
                ProcessType: string | null;
                NamespacePrefix: string | null;
              }>('SELECT ApiName, ProcessType, NamespacePrefix FROM FlowDefinitionView', 2000);
              for (const v of views) {
                if (!v.ApiName) continue;
                // Metadata API fullNames are namespace-qualified; FlowDefinitionView
                // splits the namespace out — qualify before matching, or every
                // managed flow double-lists.
                const qualified = v.NamespacePrefix ? `${v.NamespacePrefix}__${v.ApiName}` : v.ApiName;
                const existing = items.get(qualified.toLowerCase());
                if (existing) existing.source = 'both';
                else {
                  items.set(qualified.toLowerCase(), {
                    api_name: qualified,
                    process_type: v.ProcessType,
                    last_modified: null,
                    last_modified_by: null,
                    source: 'flow_definition_view',
                  });
                }
              }
            } catch {
              // FlowDefinitionView unavailable — Metadata API listing still stands.
            }
          }
          return ok({
            connection: conn.alias,
            source: 'org',
            type: args.type,
            count: items.size,
            items: [...items.values()].slice(0, 500),
            ...(args.type === 'Flow'
              ? {
                  note: 'source=flow_definition_view flows are standard/feature-delivered — invisible to the Metadata API, and their content is not exposed by any API. retrieve_metadata returns their descriptor.',
                }
              : {}),
          });
        }
        const counts = db.countArtifactsByType(conn.id);
        if (Object.keys(counts).length === 0) {
          return ok({
            connection: conn.alias,
            source: 'index',
            counts: {},
            note: 'No snapshot yet for this connection — run refresh_snapshot first.',
          });
        }
        if (!args.type) {
          return ok({ connection: conn.alias, source: 'index', counts });
        }
        const items = db.listArtifacts(conn.id, args.type);
        return ok({
          connection: conn.alias,
          source: 'index',
          type: args.type,
          count: items.length,
          items: items.slice(0, 500).map((a) => ({
            api_name: a.apiName,
            last_modified: a.lastModifiedDate,
            last_modified_by: a.lastModifiedBy,
          })),
          ...(args.type === 'Flow'
            ? {
                note: 'The snapshot only holds Metadata-API-visible flows; standard/feature-delivered flows appear with live=true (source=flow_definition_view).',
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    'retrieve_metadata',
    {
      title: 'Retrieve metadata artifacts',
      description:
        'Retrieve the source of specific artifacts (Flow XML, Apex bodies, object/field ' +
        'definitions, validation rules, labels) with a one-hop dependency summary each. ' +
        'Apex bodies come live from the Tooling API; everything else reads the local ' +
        'snapshot (refresh_snapshot if stale or missing).',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        type: z
          .string()
          .describe(
            'Metadata type: ApexClass, ApexTrigger, Flow, CustomObject, CustomField, ' +
              'ValidationRule, CustomLabel, PermissionSet.',
          ),
        names: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe('Full API names; children dotted (Account.MyField__c).'),
        max_bytes: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_CONTENT_BYTES)
          .optional()
          .describe(
            `Per-artifact content budget. Default ${DEFAULT_CONTENT_BYTES} bytes, which fits ` +
              `a large flow whole; raise it up to ${MAX_CONTENT_BYTES} to read something bigger. ` +
              'Whenever content is cut, the result says so and gives bytes_total plus ' +
              'snapshot_path, so you can read the file directly instead of guessing.',
          ),
        include_dependencies: z
          .boolean()
          .optional()
          .describe('Attach one-hop uses/used_by summaries (default true).'),
      },
    },
    async (args: {
      connection: string;
      type: string;
      names: string[];
      include_dependencies?: boolean;
      max_bytes?: number;
    }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'retrieve_metadata');
        if (!TYPE_RE.test(args.type)) return fail('invalid metadata type');
        const includeDeps = args.include_dependencies !== false;
        const perArtifact = Math.min(args.max_bytes ?? DEFAULT_CONTENT_BYTES, MAX_CONTENT_BYTES);
        let budgetLeft = CALL_CONTENT_BUDGET;
        const results: Array<Record<string, unknown>> = [];
        for (const name of args.names) {
          if (!NAME_RE.test(name)) {
            results.push({ api_name: name, error: 'invalid artifact name' });
            continue;
          }
          try {
            const content = await fetchArtifactContent(deps, conn, args.type, name);
            const allowed = Math.max(0, Math.min(perArtifact, budgetLeft));
            const cut = clampContent(content.body, allowed);
            budgetLeft -= cut.body.length;
            const entry: Record<string, unknown> = {
              api_name: name,
              type: args.type,
              content: cut.body,
              source: content.source,
              bytes_total: content.body.length,
              bytes_returned: cut.body.length,
              truncated: cut.truncated,
            };
            if (cut.truncated) {
              entry.truncated_reason =
                allowed < perArtifact ? 'call_budget' : 'max_bytes';
              // Point at the file so the caller can finish the job itself
              // rather than re-reading in blind slices.
              const rec = db.getArtifact(conn.id, args.type, name);
              const onDisk = rec?.filePath
                ? deps.store.currentFilePath(conn.id, rec.filePath)
                : null;
              if (onDisk) entry.snapshot_path = onDisk;
            }
            if (content.note) entry.note = content.note;
            if (includeDeps) {
              entry.uses = db
                .edgesFrom(conn.id, args.type, name)
                .slice(0, 15)
                .map((e) => `${e.toType}:${e.toName} (${e.source})`);
              entry.used_by = db
                .edgesTo(conn.id, args.type, name)
                .slice(0, 15)
                .map((e) => `${e.fromType}:${e.fromName} (${e.source})`);
            }
            results.push(entry);
          } catch (err) {
            results.push({
              api_name: name,
              error: String(err instanceof Error ? err.message : err),
            });
          }
        }
        return ok({ connection: conn.alias, type: args.type, artifacts: results });
      }),
  );

  server.registerTool(
    'describe_schema',
    {
      title: 'Describe an object schema',
      description:
        'Live object/field describe for one SObject: fields with types and references, ' +
        'record types, relationship counts. Compact by design; use retrieve_metadata for ' +
        'full field XML definitions.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
      },
    },
    async (args: { connection: string; object: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'describe_schema');
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
        const d = (await rest.describeSObject(args.object)) as {
          name: string;
          label: string;
          custom: boolean;
          fields: Array<Record<string, unknown>>;
          recordTypeInfos?: Array<{ name: string; developerName?: string; active?: boolean }>;
          childRelationships?: unknown[];
        };
        const fields = (d.fields ?? []).slice(0, 300).map((f) => {
          const picklist = (f.picklistValues as Array<{ value: string }> | undefined) ?? [];
          return {
            name: f.name,
            label: f.label,
            type: f.type,
            ...(f.length && (f.type === 'string' || f.type === 'textarea')
              ? { length: f.length }
              : {}),
            ...((f.referenceTo as string[] | undefined)?.length
              ? { references: f.referenceTo }
              : {}),
            ...(picklist.length
              ? {
                  picklist_values: picklist.slice(0, 10).map((p) => p.value),
                  picklist_count: picklist.length,
                }
              : {}),
            ...(f.calculated ? { formula_field: true } : {}),
            required: f.nillable === false && f.defaultedOnCreate === false,
            updateable: f.updateable === true,
          };
        });
        return ok({
          connection: conn.alias,
          object: d.name,
          label: d.label,
          custom: d.custom,
          field_count: (d.fields ?? []).length,
          fields_truncated: (d.fields ?? []).length > 300,
          fields,
          record_types: (d.recordTypeInfos ?? []).map((r) => r.developerName ?? r.name),
          child_relationship_count: (d.childRelationships ?? []).length,
        });
      }),
  );

  server.registerTool(
    'search_metadata',
    {
      title: 'Search the metadata snapshot',
      description:
        'Name and full-text content search over the local snapshot index — find artifacts ' +
        'by name fragment or by what their source mentions (a field name, a label, a class).',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        query: z.string().min(2).describe('Search text.'),
        types: z.array(z.string()).optional().describe('Restrict to these metadata types.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
      },
    },
    async (args: { connection: string; query: string; types?: string[]; limit?: number }) =>
      guarded(() => {
        const conn = requireConnection(args.connection, 'search_metadata');
        const results = db.searchArtifacts(conn.id, args.query, args.types, args.limit ?? 20);
        if (results.length === 0 && Object.keys(db.countArtifactsByType(conn.id)).length === 0) {
          return ok({
            connection: conn.alias,
            results: [],
            note: 'No snapshot yet for this connection — run refresh_snapshot first.',
          });
        }
        return ok({ connection: conn.alias, query: args.query, results });
      }),
  );

  server.registerTool(
    'get_dependencies',
    {
      title: 'Query the dependency graph',
      description:
        'Neighborhood, reverse dependencies, and blast radius for one artifact from the ' +
        'local dependency graph (org dependency API + Contrail\'s reference extractor). ' +
        '"used_by" answers: what breaks if I change this?',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        type: z.string().describe('Metadata type of the root artifact.'),
        name: z.string().describe('Full API name of the root artifact.'),
        direction: z
          .enum(['uses', 'used_by', 'both'])
          .optional()
          .describe('Traversal direction (default both).'),
        depth: z.number().int().min(1).max(3).optional().describe('Hops from the root (default 1).'),
      },
    },
    async (args: {
      connection: string;
      type: string;
      name: string;
      direction?: 'uses' | 'used_by' | 'both';
      depth?: number;
    }) =>
      guarded(() => {
        const conn = requireConnection(args.connection, 'get_dependencies');
        const known =
          db.getArtifact(conn.id, args.type, args.name) !== null ||
          db.edgesFrom(conn.id, args.type, args.name).length > 0 ||
          db.edgesTo(conn.id, args.type, args.name).length > 0;
        if (!known) {
          return fail(
            `No artifact or edges found for ${args.type}:${args.name} in the local graph. ` +
              `Check the name with search_metadata or list_metadata, or run refresh_snapshot.`,
          );
        }
        const graph = queryDependencies(
          db,
          conn.id,
          args.type,
          args.name,
          args.direction ?? 'both',
          args.depth ?? 1,
        );
        return ok({ connection: conn.alias, ...graph });
      }),
  );

  server.registerTool(
    'refresh_snapshot',
    {
      title: 'Refresh the metadata snapshot',
      description:
        'Manifest-driven re-retrieve of the org\'s metadata into the local snapshot + index ' +
        '+ dependency graph. Long-running on big orgs: an in-progress result means call ' +
        'refresh_snapshot again to check on it. check_only=true just reports staleness.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        types: z
          .array(z.string())
          .optional()
          .describe('Metadata types to refresh (default: the configured manifest).'),
        check_only: z
          .boolean()
          .optional()
          .describe('Only compare org lastModifiedDate against the index; retrieve nothing.'),
      },
    },
    async (args: { connection: string; types?: string[]; check_only?: boolean }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'refresh_snapshot');
        if (args.types?.some((t) => !TYPE_RE.test(t))) return fail('invalid metadata type');
        if (args.check_only) {
          const report = await engine.checkStaleness(conn, args.types);
          return ok({ connection: conn.alias, ...report });
        }
        const outcome = await engine.refresh(conn, args.types);
        switch (outcome.status) {
          case 'complete':
            return ok(outcome.summary, 'Snapshot refreshed.');
          case 'failed':
            return fail(`Snapshot refresh failed: ${outcome.error}`);
          case 'in_progress':
            return ok(
              outcome.state,
              'Refresh is still running. Call refresh_snapshot again with the same ' +
                'connection to check progress or collect the result.',
            );
        }
      }),
  );

  server.registerTool(
    'get_org_changes',
    {
      title: 'Org drift report (live org vs local snapshot)',
      description:
        "Compare the org's LIVE metadata inventory (listMetadata) against the local " +
        'snapshot index: what changed in the org since your snapshot — modified, ' +
        'new-in-org, gone-from-org — grouped by who changed it. The consultant\'s "what ' +
        'changed under me". Coverage is the snapshot\'s: only indexed top-level types are ' +
        'compared (child types like CustomField ride their object), and items from managed ' +
        'packages are skipped. Baseline is per artifact (its indexed lastModifiedDate, ' +
        'else its retrieval time) unless `since` overrides it. Drill in with ' +
        'retrieve_metadata / diff_artifact; re-baseline with refresh_snapshot.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        since: z
          .string()
          .optional()
          .describe(
            'ISO date/datetime: report org changes after this moment instead of since the snapshot.',
          ),
        types: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Restrict to these metadata types (default: every indexed top-level type).'),
      },
    },
    async (args: { connection: string; since?: string; types?: string[] }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'get_org_changes');
        let sinceMs: number | null = null;
        if (args.since !== undefined) {
          sinceMs = Date.parse(args.since);
          if (Number.isNaN(sinceMs)) return fail('since must be an ISO date or datetime.');
        }
        if (args.types?.some((t) => !TYPE_RE.test(t))) return fail('invalid metadata type');

        const counts = db.countArtifactsByType(conn.id);
        const indexedTopLevel = Object.keys(counts).filter((t) => !ORG_CHANGES_CHILD_TYPES.has(t));
        if (indexedTopLevel.length === 0) {
          return fail('No snapshot index for this connection — run refresh_snapshot first.');
        }
        const requested = args.types ?? indexedTopLevel;
        const types = requested.filter((t) => indexedTopLevel.includes(t));
        const skipped = requested.filter((t) => !indexedTopLevel.includes(t));
        if (types.length === 0) {
          return fail(
            `None of the requested types are indexed for "${conn.alias}" — indexed types: ` +
              `${indexedTopLevel.join(', ')}. Run refresh_snapshot to widen coverage.`,
          );
        }

        const soap = new MetadataSoapClient(tokenMgr, conn, config.salesforce.apiVersion);
        const props = await soap.listMetadata(types);
        let managedSkipped = 0;
        const orgByType = new Map<string, Map<string, (typeof props)[number]>>();
        for (const p of props) {
          if (p.manageableState === 'installed') {
            managedSkipped += 1;
            continue;
          }
          const m = orgByType.get(p.type) ?? new Map<string, (typeof props)[number]>();
          m.set(p.fullName.toLowerCase(), p);
          orgByType.set(p.type, m);
        }

        interface ChangeEntry {
          type: string;
          api_name: string;
          last_modified: string | null;
          last_modified_by: string | null;
          baseline?: string;
        }
        const modified: ChangeEntry[] = [];
        const newInOrg: ChangeEntry[] = [];
        const gone: Array<{ type: string; api_name: string }> = [];

        for (const t of types) {
          const orgMap = orgByType.get(t) ?? new Map<string, (typeof props)[number]>();
          for (const row of db.listArtifacts(conn.id, t)) {
            const key = row.apiName.toLowerCase();
            const org = orgMap.get(key);
            if (!org) {
              gone.push({ type: t, api_name: row.apiName });
              continue;
            }
            orgMap.delete(key);
            // Per-artifact baseline: the indexed lastModifiedDate when the org
            // reported one at snapshot time, else the retrieval moment.
            const baselineIso =
              sinceMs !== null ? (args.since as string) : (row.lastModifiedDate ?? row.retrievedAt);
            const baseMs = sinceMs !== null ? sinceMs : Date.parse(baselineIso);
            const orgMs = Date.parse(org.lastModifiedDate ?? '');
            if (!Number.isNaN(orgMs) && !Number.isNaN(baseMs) && orgMs > baseMs) {
              modified.push({
                type: t,
                api_name: org.fullName,
                last_modified: org.lastModifiedDate ?? null,
                last_modified_by: org.lastModifiedByName ?? null,
                baseline: baselineIso,
              });
            }
          }
          for (const p of orgMap.values()) {
            if (sinceMs !== null) {
              const ms = Date.parse(p.lastModifiedDate ?? '');
              if (!Number.isNaN(ms) && ms <= sinceMs) continue;
            }
            newInOrg.push({
              type: t,
              api_name: p.fullName,
              last_modified: p.lastModifiedDate ?? null,
              last_modified_by: p.lastModifiedByName ?? null,
            });
          }
        }

        const byDateDesc = (a: ChangeEntry, b: ChangeEntry) =>
          (b.last_modified ?? '').localeCompare(a.last_modified ?? '');
        modified.sort(byDateDesc);
        newInOrg.sort(byDateDesc);
        const byUser: Record<string, { modified: number; new_in_org: number }> = {};
        for (const e of modified) {
          const who = e.last_modified_by ?? '(unknown)';
          (byUser[who] ??= { modified: 0, new_in_org: 0 }).modified += 1;
        }
        for (const e of newInOrg) {
          const who = e.last_modified_by ?? '(unknown)';
          (byUser[who] ??= { modified: 0, new_in_org: 0 }).new_in_org += 1;
        }

        const CAP = 150;
        return ok({
          connection: conn.alias,
          compared_types: types,
          ...(skipped.length
            ? { skipped_types: skipped, skipped_note: 'not in the local index (child types ride their parent object)' }
            : {}),
          since: args.since ?? null,
          totals: {
            modified: modified.length,
            new_in_org: newInOrg.length,
            gone_from_org: gone.length,
            managed_package_items_skipped: managedSkipped,
          },
          by_user: byUser,
          modified: modified.slice(0, CAP),
          new_in_org: newInOrg.slice(0, CAP),
          gone_from_org: gone.slice(0, CAP),
          ...(modified.length > CAP || newInOrg.length > CAP || gone.length > CAP
            ? { truncated: true, truncated_note: `entry lists capped at ${CAP} — totals are exact` }
            : {}),
          note:
            args.since != null
              ? `Org changes after ${args.since} (gone_from_org is always relative to the snapshot).`
              : 'Baseline is the local snapshot — each modified entry names the baseline it beat. ' +
                'Totals count org-side drift, not local edits.',
        });
      }),
  );

  server.registerTool(
    'get_setup_audit',
    {
      title: 'Setup audit trail (config changes)',
      description:
        "Read the org's SetupAuditTrail — the configuration changes that never surface as " +
        'metadata: profile edits made in Setup, user activations, permission assignments, ' +
        'email deliverability, login-as sessions, and the rest. Grouped by section and by ' +
        'admin. Salesforce retains about 180 days; entries are what the org recorded, ' +
        'verbatim.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe('Look-back window in days (default 7).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max entries to return (default 200) — the org-side total is always reported.'),
      },
    },
    async (args: { connection: string; days?: number; limit?: number }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'get_setup_audit');
        const days = args.days ?? 7;
        const cap = args.limit ?? 200;
        const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
        const { records, totalSize } = await rest.queryWithCount<{
          Action: string | null;
          Section: string | null;
          Display: string | null;
          CreatedDate: string;
          CreatedBy: { Name: string | null; Username: string | null } | null;
          DelegateUser: string | null;
        }>(
          `SELECT Action, Section, Display, CreatedDate, CreatedBy.Name, CreatedBy.Username, ` +
            `DelegateUser FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:${days} ` +
            `ORDER BY CreatedDate DESC`,
          cap,
        );
        const bySection: Record<string, number> = {};
        const byUser: Record<string, number> = {};
        const events = records.map((r) => {
          const section = r.Section ?? '(none)';
          const who = r.CreatedBy?.Name ?? r.CreatedBy?.Username ?? '(system)';
          bySection[section] = (bySection[section] ?? 0) + 1;
          byUser[who] = (byUser[who] ?? 0) + 1;
          return {
            at: r.CreatedDate,
            by: who,
            section,
            action: r.Action,
            display: r.Display,
            ...(r.DelegateUser ? { as_delegate_of: r.DelegateUser } : {}),
          };
        });
        return ok({
          connection: conn.alias,
          days,
          total_size: totalSize,
          returned: events.length,
          truncated: totalSize !== null && totalSize > events.length,
          by_section: bySection,
          by_user: byUser,
          events,
          ...(totalSize !== null && totalSize > events.length
            ? { note: `Showing the newest ${events.length} of ${totalSize} — raise limit or narrow days.` }
            : {}),
        });
      }),
  );
}

async function fetchArtifactContent(
  deps: ToolDeps,
  conn: ConnectionRecord,
  type: string,
  name: string,
): Promise<{ body: string; source: string; note?: string }> {
  const { db, store, tokenMgr, config } = deps;

  if (type === 'ApexClass' || type === 'ApexTrigger') {
    const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
    try {
      const { ns, short } = splitNamespace(name);
      const rows = await rest.toolingQuery<{ Body: string; NamespacePrefix: string | null }>(
        `SELECT Body, NamespacePrefix FROM ${type} WHERE Name = '${short.replaceAll("'", "\\'")}'`,
        10,
      );
      const row = pickByNamespace(rows, ns);
      // Managed bodies come back as the literal "(hidden)" — not useful content.
      if (row?.Body && row.Body !== '(hidden)') {
        return { body: row.Body, source: 'tooling_api_live' };
      }
    } catch {
      // fall through to snapshot
    }
    const fromSnapshot = readSnapshotArtifact(deps, conn, type, name);
    if (fromSnapshot) {
      return {
        body: fromSnapshot,
        source: 'snapshot',
        note: 'Live Tooling API read failed or returned nothing; this is the snapshot copy.',
      };
    }
    throw new ContrailError(
      `${type} ${name} not found via the Tooling API or the local snapshot.`,
      'artifact_not_found',
    );
  }

  if (type === 'Flow') {
    const body = readSnapshotArtifact(deps, conn, type, name);
    if (body) return { body, source: 'snapshot' };
    // Standard/feature-delivered flows never appear in Metadata API
    // retrieves; fall back to the Tooling API before reporting not-found.
    const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
    const { ns, short } = splitNamespace(name);
    const escaped = short.replaceAll("'", "\\'");
    const defs = pickAllByNamespace(
      await rest.toolingQuery<{
        Id: string;
        ActiveVersionId: string | null;
        LatestVersionId: string | null;
        NamespacePrefix: string | null;
      }>(
        `SELECT Id, ActiveVersionId, LatestVersionId, NamespacePrefix FROM FlowDefinition ` +
          `WHERE DeveloperName = '${escaped}'`,
        10,
      ),
      ns,
    );
    const versionId = defs[0]?.ActiveVersionId ?? defs[0]?.LatestVersionId;
    if (versionId) {
      const versions = await rest.toolingQuery<{ Metadata: unknown }>(
        `SELECT Metadata FROM Flow WHERE Id = '${versionId.replaceAll("'", "\\'")}'`,
        1,
      );
      if (versions[0]?.Metadata) {
        return {
          body: JSON.stringify(versions[0].Metadata, null, 2),
          source: 'tooling_api_live',
          note:
            'This flow is not visible to the Metadata API. This is the Tooling API JSON ' +
            `representation of the ${defs[0]?.ActiveVersionId ? 'active' : 'latest'} version.`,
        };
      }
    }
    // Platform/feature-delivered flows expose no content through ANY API —
    // return the FlowDefinitionView descriptor instead of a dead not-found.
    const views = pickAllByNamespace(
      await rest.query<Record<string, unknown> & { NamespacePrefix: string | null }>(
        `SELECT ApiName, Label, ProcessType, TriggerType, IsActive, NamespacePrefix, ` +
          `Description, ActiveVersionId FROM FlowDefinitionView WHERE ApiName = '${escaped}'`,
        10,
      ),
      ns,
    );
    if (views[0]) {
      return {
        body: JSON.stringify(stripAttributes(views[0]), null, 2),
        source: 'flow_definition_view',
        note:
          'This flow is platform/feature-delivered: Salesforce does not expose its definition ' +
          'content through the Metadata or Tooling APIs. This descriptor (identity, type, ' +
          'active status) is everything the platform makes available.',
      };
    }
    throw new ContrailError(
      `Flow ${name} not found in the snapshot, the Tooling API, or FlowDefinitionView. Check ` +
        `the name with list_metadata (live=true unions all sources) or run refresh_snapshot.`,
      'artifact_not_found',
    );
  }

  const child = Object.hasOwn(CHILD_SPEC, type) ? CHILD_SPEC[type] : undefined;
  if (child) {
    const [parentName, childName] = splitChildName(type, name);
    const parentArtifact = db.getArtifact(conn.id, child.parentType, parentName);
    const parentXml = parentArtifact?.filePath
      ? store.readCurrentFile(conn.id, parentArtifact.filePath)
      : null;
    if (!parentXml) {
      throw new ContrailError(
        `${child.parentType} ${parentName} is not in the local snapshot — run refresh_snapshot.`,
        'artifact_not_found',
      );
    }
    const block = findChildBlock(parentXml, child.tag, childName);
    if (!block) {
      throw new ContrailError(
        `${type} ${name} not found inside ${child.parentType} ${parentName} in the snapshot.`,
        'artifact_not_found',
      );
    }
    return { body: block, source: 'snapshot' };
  }

  const body = readSnapshotArtifact(deps, conn, type, name);
  if (!body) {
    throw new ContrailError(
      `${type} ${name} is not in the local snapshot — run refresh_snapshot (or check the name ` +
        `with list_metadata / search_metadata).`,
      'artifact_not_found',
    );
  }
  return { body, source: 'snapshot' };
}

function readSnapshotArtifact(
  deps: ToolDeps,
  conn: ConnectionRecord,
  type: string,
  name: string,
): string | null {
  const artifact = deps.db.getArtifact(conn.id, type, name);
  if (!artifact?.filePath) return null;
  return deps.store.readCurrentFile(conn.id, artifact.filePath);
}

/**
 * Snapshot-only artifact read (no live fallbacks) — the deterministic source
 * the diff tools compare. Children resolve to their XML fragment.
 */
export function readArtifactFromSnapshot(
  deps: ToolDeps,
  conn: ConnectionRecord,
  type: string,
  name: string,
): string | null {
  const child = Object.hasOwn(CHILD_SPEC, type) ? CHILD_SPEC[type] : undefined;
  if (child) {
    const [parentName, childName] = splitChildName(type, name);
    const parentXml = readSnapshotArtifact(deps, conn, child.parentType, parentName);
    if (!parentXml) return null;
    return findChildBlock(parentXml, child.tag, childName);
  }
  return readSnapshotArtifact(deps, conn, type, name);
}

/**
 * Split a namespace-qualified API name at the FIRST double underscore.
 * Namespaces themselves may contain single underscores (e.g. sales_channel),
 * but no valid API name contains consecutive underscores except as the
 * namespace separator (custom suffixes like __c never apply to Apex/Flow names).
 */
function splitNamespace(name: string): { ns: string | null; short: string } {
  const idx = name.indexOf('__');
  if (idx <= 0) return { ns: null, short: name };
  return { ns: name.slice(0, idx), short: name.slice(idx + 2) };
}

/**
 * Resolve namespace intent against query rows: a qualified name demands its
 * exact namespace; a bare name prefers the local (null-namespace) row but
 * accepts a single unambiguous namespaced match (the ledger's
 * get_existing_swarm case, where the platform owns the namespace).
 */
function pickByNamespace<T extends { NamespacePrefix: string | null }>(
  rows: T[],
  ns: string | null,
): T | undefined {
  const exact = rows.find((r) => (r.NamespacePrefix ?? null) === ns);
  if (exact) return exact;
  if (ns === null && rows.length === 1) return rows[0];
  return undefined;
}

function pickAllByNamespace<T extends { NamespacePrefix: string | null }>(
  rows: T[],
  ns: string | null,
): T[] {
  const picked = pickByNamespace(rows, ns);
  return picked ? [picked] : [];
}

function splitChildName(type: string, name: string): [string, string] {
  if (type === 'CustomLabel') return ['CustomLabels', name];
  const idx = name.indexOf('.');
  if (idx === -1) {
    throw new ContrailError(
      `${type} names are dotted (Parent.Child), got "${name}".`,
      'bad_artifact_name',
    );
  }
  return [name.slice(0, idx), name.slice(idx + 1)];
}

function clampContent(body: string, allowed: number): { body: string; truncated: boolean } {
  if (body.length <= allowed) return { body, truncated: false };
  // Keep the inline marker as well as the structured fields: a model reading
  // the content must see the cut at the point it happens, not only in a
  // sibling key it might skim past.
  return {
    body: `${body.slice(0, allowed)}\n… [truncated ${body.length - allowed} more characters]`,
    truncated: true,
  };
}
