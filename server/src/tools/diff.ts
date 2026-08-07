import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import { readArtifactFromSnapshot } from './metadata.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import { semanticDiff } from '../diff/semantic.js';

/**
 * Semantic diff tools (spec §4): cross-org comparison over local snapshots.
 * metadata_read is required on BOTH connections — the layer-2 gate runs per
 * connection, so one granted org can never leak another's metadata.
 */

const TYPE_RE = /^[A-Za-z]+$/;
const NAME_RE = /^[A-Za-z0-9_.\- ]+$/;
const BUCKET_LIST_CAP = 50;

export function registerDiffTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit } = deps;

  function requireBoth(refA: string, refB: string, tool: string): [ConnectionRecord, ConnectionRecord] {
    const a = db.resolveConnection(refA);
    if (!a) throw new ConnectionNotFoundError(refA);
    const b = db.resolveConnection(refB);
    if (!b) throw new ConnectionNotFoundError(refB);
    assertGrant(a, tool, audit);
    assertGrant(b, tool, audit);
    return [a, b];
  }

  server.registerTool(
    'diff_orgs',
    {
      title: 'Diff two orgs',
      description:
        'Compare the metadata snapshots of two connections (e.g. sandbox vs production): ' +
        'what exists only in one, what differs, what is identical — bucketed by type. ' +
        'Requires metadata_read on BOTH connections and a snapshot on each ' +
        '(refresh_snapshot first). Use diff_artifact for the detail of one artifact.',
      inputSchema: {
        connection_a: z.string().describe('The "from" connection alias (e.g. the sandbox).'),
        connection_b: z.string().describe('The "to" connection alias (e.g. production).'),
        types: z.array(z.string()).optional().describe('Restrict to these metadata types.'),
      },
    },
    async (args: { connection_a: string; connection_b: string; types?: string[] }) =>
      guarded(() => {
        if (args.types?.some((t) => !TYPE_RE.test(t))) return fail('invalid metadata type');
        const [a, b] = requireBoth(args.connection_a, args.connection_b, 'diff_orgs');
        const aArtifacts = db.listArtifacts(a.id);
        const bArtifacts = db.listArtifacts(b.id);
        for (const [conn, list] of [
          [a, aArtifacts],
          [b, bArtifacts],
        ] as const) {
          if (list.length === 0) {
            return fail(
              `Connection "${conn.alias}" has no metadata snapshot. Run refresh_snapshot on it first.`,
            );
          }
        }
        const typeFilter = args.types?.length ? new Set(args.types) : null;
        const aMap = new Map(
          aArtifacts
            .filter((x) => !typeFilter || typeFilter.has(x.type))
            .map((x) => [`${x.type}:${x.apiName.toLowerCase()}`, x]),
        );
        const bMap = new Map(
          bArtifacts
            .filter((x) => !typeFilter || typeFilter.has(x.type))
            .map((x) => [`${x.type}:${x.apiName.toLowerCase()}`, x]),
        );

        const counts: Record<
          string,
          { identical: number; changed: number; only_in_a: number; only_in_b: number }
        > = {};
        const bucket = (type: string) =>
          (counts[type] ??= { identical: 0, changed: 0, only_in_a: 0, only_in_b: 0 });
        const changed: string[] = [];
        const onlyA: string[] = [];
        const onlyB: string[] = [];

        for (const [key, aArt] of aMap) {
          const bArt = bMap.get(key);
          if (!bArt) {
            bucket(aArt.type).only_in_a++;
            onlyA.push(`${aArt.type}:${aArt.apiName}`);
          } else if (aArt.contentHash === bArt.contentHash) {
            bucket(aArt.type).identical++;
          } else {
            bucket(aArt.type).changed++;
            changed.push(`${aArt.type}:${aArt.apiName}`);
          }
        }
        for (const [key, bArt] of bMap) {
          if (!aMap.has(key)) {
            bucket(bArt.type).only_in_b++;
            onlyB.push(`${bArt.type}:${bArt.apiName}`);
          }
        }

        const newest = (list: typeof aArtifacts) =>
          list.reduce<string | null>(
            (acc, x) => (acc && acc > x.retrievedAt ? acc : x.retrievedAt),
            null,
          );
        return ok({
          from: a.alias,
          to: b.alias,
          snapshot_taken: { [a.alias]: newest(aArtifacts), [b.alias]: newest(bArtifacts) },
          counts_by_type: counts,
          changed: changed.slice(0, BUCKET_LIST_CAP),
          changed_truncated: changed.length > BUCKET_LIST_CAP,
          only_in_a: onlyA.slice(0, BUCKET_LIST_CAP),
          only_in_a_truncated: onlyA.length > BUCKET_LIST_CAP,
          only_in_b: onlyB.slice(0, BUCKET_LIST_CAP),
          only_in_b_truncated: onlyB.length > BUCKET_LIST_CAP,
          note:
            'Buckets compare snapshot content hashes. Use diff_artifact for the semantic ' +
            'detail of any changed artifact. Consider refresh_snapshot on both sides if the ' +
            'snapshot timestamps are stale.',
        });
      }),
  );

  server.registerTool(
    'diff_artifact',
    {
      title: 'Semantic diff of one artifact across two orgs',
      description:
        'Structural diff of a single artifact between two connections\' snapshots: XML ' +
        'metadata diffs by element (reorders are not changes; keyed children match by ' +
        'fullName/name), Apex diffs by line with hunks. Requires metadata_read on BOTH ' +
        'connections. Direction is A → B: "added" means present only in B.',
      inputSchema: {
        connection_a: z.string().describe('The "from" connection alias.'),
        connection_b: z.string().describe('The "to" connection alias.'),
        type: z.string().describe('Metadata type, e.g. Flow, ApexClass, CustomObject, CustomField.'),
        name: z.string().describe('Full API name; children dotted (Account.MyField__c).'),
      },
    },
    async (args: { connection_a: string; connection_b: string; type: string; name: string }) =>
      guarded(() => {
        if (!TYPE_RE.test(args.type)) return fail('invalid metadata type');
        if (!NAME_RE.test(args.name)) return fail('invalid artifact name');
        const [a, b] = requireBoth(args.connection_a, args.connection_b, 'diff_artifact');

        const aContent = readArtifactFromSnapshot(deps, a, args.type, args.name);
        const bContent = readArtifactFromSnapshot(deps, b, args.type, args.name);
        const base = { from: a.alias, to: b.alias, type: args.type, name: args.name };

        if (aContent === null && bContent === null) {
          return fail(
            `${args.type} ${args.name} is in neither snapshot. Check the name with ` +
              `search_metadata, or run refresh_snapshot on both connections. (Standard/` +
              `feature-delivered flows never enter snapshots — retrieve_metadata each side ` +
              `individually for those.)`,
          );
        }
        if (aContent === null) {
          return ok({ ...base, status: 'only_in_b' }, `Exists only in ${b.alias}.`);
        }
        if (bContent === null) {
          return ok({ ...base, status: 'only_in_a' }, `Exists only in ${a.alias}.`);
        }
        const diff = semanticDiff(aContent, bContent);
        return ok({
          ...base,
          status: diff.identical ? 'identical' : 'changed',
          format: diff.format,
          ...(diff.xml ? { xml_diff: diff.xml } : {}),
          ...(diff.text ? { text_diff: diff.text } : {}),
        });
      }),
  );
}
