import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { LocalDiagResult } from '../localdiag/types.js';

/**
 * check_apex / check_soql — local static diagnostics via the vendored
 * Salesforce language servers (server/vendor/, see PROVENANCE.md). No org, no
 * grant (the same zero-cost class as list_connections): everything runs
 * offline against bundles that ship with the install.
 *
 * The result shape is the honesty contract: `checked:false` with an
 * `unavailable` code is a SUCCESSFUL structured answer (never isError — an
 * error would train agents to retry instead of falling back), and a check
 * that did not run never masquerades as clean.
 */

/** Advisory attached when Apex diagnostics include semantic (non-parser) findings. */
const APEX_ADVISORY =
  'Semantic findings here are judged against the Apex standard library and this source ' +
  'alone — the checker cannot see the org. Syntax errors are definitive; treat semantic ' +
  'findings as strong hints and validate_deploy as the authority.';

function renderResult(result: LocalDiagResult, language: 'apex' | 'soql') {
  if (!result.checked) {
    return ok(
      {
        checked: false,
        language,
        unavailable: result.unavailable,
        detail: result.detail,
      },
      `${language === 'apex' ? 'check_apex' : 'check_soql'}=unavailable: ${result.unavailable}. ` +
        'The input was NOT checked — do not treat this as a pass; fall back to validate_deploy ' +
        'as the authority.',
    );
  }
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning').length;
  const advisory =
    language === 'apex' && result.diagnostics.some((d) => !/\.syntax$/.test(d.code ?? ''));
  return ok({
    checked: true,
    language,
    error_count: errors,
    warning_count: warnings,
    diagnostics: result.diagnostics,
    ...(advisory ? { note: APEX_ADVISORY } : {}),
  });
}

export function registerLocalDiagTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'check_apex',
    {
      title: 'Check Apex locally (static diagnostics, no org)',
      description:
        'Static Apex diagnostics from a local Salesforce language server — free, offline, ' +
        'no org traffic, no approval. Catches syntax errors definitively, plus semantic ' +
        'findings against the Apex standard library. Run it on authored Apex BEFORE ' +
        'validate_deploy spends an org round trip. Honest limits: it is NOT the org\'s ' +
        'compiler and sees NO org metadata — references to org-specific custom types and ' +
        'fields are silently TOLERATED (a typo in Custom_Field__c will not be flagged ' +
        'here), so a clean result never replaces validate_deploy. Each check takes a few ' +
        'seconds (a fresh checker runs per call — the price of trustworthy results). If ' +
        'the result says unavailable, the code was NOT checked — say so and move on to ' +
        'validate_deploy.',
      inputSchema: {
        code: z.string().min(1).max(500_000).describe('The Apex source, verbatim.'),
        type: z
          .enum(['class', 'trigger', 'anonymous'])
          .optional()
          .describe('What the source is (default class) — selects the parser.'),
      },
    },
    async (args: { code: string; type?: 'class' | 'trigger' | 'anonymous' }) =>
      guarded(async () => {
        if (args.code.trim().length === 0) return fail('The source is empty.');
        const result = await deps.localDiag.checkApex(args.code, args.type ?? 'class');
        return renderResult(result, 'apex');
      }),
  );

  server.registerTool(
    'check_soql',
    {
      title: 'Check SOQL syntax locally (no org)',
      description:
        'Parse a SOQL query with a local Salesforce language server — free, offline, no ' +
        'org traffic. SYNTAX ONLY: it does not know the org\'s objects or fields, so a ' +
        'clean parse says the grammar is right, not that the query will run. Use it before ' +
        'sending novel or generated SOQL to soql_query. If the result says unavailable, ' +
        'the query was NOT checked.',
      inputSchema: {
        query: z.string().min(1).max(50_000).describe('The SOQL query, verbatim.'),
      },
    },
    async (args: { query: string }) =>
      guarded(async () => {
        if (args.query.trim().length === 0) return fail('The query is empty.');
        const result = await deps.localDiag.checkSoql(args.query);
        return renderResult(result, 'soql');
      }),
  );
}
