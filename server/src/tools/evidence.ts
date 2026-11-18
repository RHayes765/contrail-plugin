import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps, ToolResult } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { ConnectionRecord } from '../core/types.js';
import { evidenceDir } from '../core/paths.js';
import { ENGINE_VERSION } from '../core/version.js';
import {
  evidenceRequestOf,
  exportChangeEvidence,
  type EvidenceIdentity,
  type EvidenceIo,
} from '../deploy/evidence.js';

/**
 * S46 (B): export_change_evidence — a dossier of what Contrail validated,
 * proposed and executed, written as evidence.md and evidence.json into a new
 * folder under the data directory's evidence/ (never staging, never a deploy
 * source root), for the human to hand on. Contrail's own local record: no
 * org call, no grant, and it mints no code, so no Remote Control sampling.
 *
 * The dossier is built by deploy/evidence.ts (a byte-identical mirror unit)
 * through the plain functions below; each request row is mapped by name and
 * its confirmation code is never read. The agent gets the folder path and
 * counts only — never the dossier's text.
 */

const NO_FILTER =
  'Name at least one of connection, ticket, request_id or since. An unfiltered dossier would ' +
  "mix every connection's changes in one folder.";

function identityOf(rec: ConnectionRecord): EvidenceIdentity {
  return {
    alias: rec.alias,
    org_id: rec.orgId,
    org_name: rec.orgName,
    org_type: rec.orgType,
    username: rec.username,
  };
}

export function registerEvidenceTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit } = deps;

  server.registerTool(
    'export_change_evidence',
    {
      title: 'Export change evidence',
      description:
        'Write a change-evidence dossier — evidence.md and evidence.json — for the writes ' +
        'Contrail validated, proposed and executed, into a new folder under Contrail\'s data ' +
        'directory (evidence/, never staging), and return only the folder path and counts. Per ' +
        'request: kind, connection and org, ticket, the justification and who wrote it (the ' +
        "agent's draft, or the human at approval), the policy rules that applied and any " +
        'freeze override with its emergency reason, the acting Salesforce user, when it was ' +
        'proposed and executed, what the approval summary showed (never the confirmation ' +
        'code), deploy pre-image fingerprints and last-modified stamps, the execute-time target ' +
        "check, the org's result, the revert package location, and the request's audit events. " +
        'Record field values are left out: data-change rows are reduced to operation, object ' +
        'and record id, scripts and CSV files to fingerprints. It reports what Contrail recorded ' +
        "on this machine — not the org's current state, and not changes made outside Contrail. " +
        'Name at least one of connection, ticket, request_id or since.',
      inputSchema: {
        connection: z
          .string()
          .optional()
          .describe('Connection alias (or id) whose requests to include.'),
        ticket: z
          .string()
          .max(120)
          .optional()
          .describe('Only requests recorded with exactly this ticket (case-insensitive).'),
        request_id: z
          .string()
          .max(100)
          .optional()
          .describe('One request, by the request_id a validate or propose result returned.'),
        since: z
          .string()
          .max(100)
          .optional()
          .describe('ISO 8601 timestamp bounding when the request was proposed.'),
        until: z
          .string()
          .max(100)
          .optional()
          .describe('ISO 8601 timestamp bounding when the request was proposed.'),
      },
    },
    async (args: {
      connection?: string;
      ticket?: string;
      request_id?: string;
      since?: string;
      until?: string;
    }) =>
      guarded((): ToolResult => {
        let conn: ConnectionRecord | undefined;
        if (args.connection) {
          const rec = db.resolveConnection(args.connection);
          if (!rec) {
            return fail(
              `No connection matches "${args.connection}". Call list_connections to see what exists.`,
            );
          }
          conn = rec;
        }
        const io: EvidenceIo = {
          // Mapped by name: the row's confirmation code is never read.
          queryRequests: (f) => db.queryDeployRequests(f).map((rec) => evidenceRequestOf(rec)),
          getConnection: (id) => {
            const rec = db.getConnection(id);
            return rec ? identityOf(rec) : null;
          },
          queryAudit: (f) =>
            audit.query(f).map((e) => ({
              ts: e.ts,
              event_type: e.eventType,
              connection_id: e.connectionId,
              tool: e.tool,
              outcome: e.outcome,
              detail: e.detail,
            })),
          policyStatus: () => {
            const s = deps.deploys.policiesStatus();
            return s.status === 'ok' ? { status: 'ok', source: s.source } : { status: 'unreadable' };
          },
          evidenceDir,
          now: () => Date.now(),
          engineVersion: ENGINE_VERSION,
          surface: 'plugin',
        };
        const outcome = exportChangeEvidence(io, {
          ...(conn ? { connection: { id: conn.id, alias: conn.alias } } : {}),
          ticket: args.ticket,
          request_id: args.request_id,
          since: args.since,
          until: args.until,
        });
        switch (outcome.status) {
          case 'refused':
            if (outcome.refusal === 'no_filter') return fail(NO_FILTER);
            if (outcome.refusal === 'request_not_found') {
              const on = outcome.connection !== null ? ` on "${outcome.connection}"` : '';
              // The window bounds the id search too: say so, or an existing
              // request outside it reads as one that does not exist.
              const win = args.since || args.until ? ' proposed within the given since/until' : '';
              return fail(`No request matches request_id "${outcome.request_id}"${on}${win}.`);
            }
            return fail(
              `${outcome.field} must be an ISO 8601 timestamp (for example 2026-11-17T09:00:00Z), ` +
                `got "${outcome.value}".`,
            );
          case 'empty':
            return ok(
              { path: null, requests: 0, policy_refusals: 0 },
              'Nothing matched those filters — no dossier was written.',
            );
          case 'written':
            audit.record('evidence.exported', {
              connectionId: conn?.id ?? null,
              tool: 'export_change_evidence',
              outcome: 'success',
              detail: {
                requests: outcome.requests,
                policy_refusals: outcome.policy_refusals,
                // The folder's name only — never the path on this machine.
                folder: outcome.folder,
                filters: {
                  connection: conn?.alias ?? null,
                  ticket: args.ticket ?? null,
                  request_id: args.request_id ?? null,
                  since: args.since ?? null,
                  until: args.until ?? null,
                },
              },
            });
            return ok(
              {
                path: outcome.path,
                files: outcome.files,
                requests: outcome.requests,
                by_status: outcome.by_status,
                audit_events: outcome.audit_events,
                policy_refusals: outcome.policy_refusals,
                truncated: outcome.truncated,
              },
              "Change evidence written to the folder below, on the human's machine and outside " +
                'staging. Give them the path; the files contain no confirmation codes and no ' +
                'record field values.',
            );
        }
      }),
  );
}
