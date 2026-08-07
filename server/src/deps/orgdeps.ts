import type { RestClient } from '../salesforce/rest.js';
import type { DependencyEdge } from '../core/types.js';
import { log } from '../core/log.js';

/**
 * Org-computed dependencies via the Tooling MetadataComponentDependency
 * object (beta, capped at 2000 rows per query and no queryMore — so we query
 * per component type). Best-effort: orgs without the feature just fall back
 * to the extractor edges.
 */

interface McdRow {
  MetadataComponentName: string;
  MetadataComponentType: string;
  RefMetadataComponentName: string;
  RefMetadataComponentType: string;
}

export async function fetchOrgDependencyEdges(
  rest: RestClient,
  connectionId: string,
  types: string[],
): Promise<{ edges: DependencyEdge[]; warnings: string[] }> {
  const edges: DependencyEdge[] = [];
  const warnings: string[] = [];
  for (const type of types) {
    // Defense in depth — types are validated at the tool boundary, but this
    // string is interpolated into a query and cheap to re-check.
    if (!/^[A-Za-z]+$/.test(type)) {
      warnings.push(`skipped org dependency query for invalid type "${type}"`);
      continue;
    }
    try {
      const rows = await rest.toolingQuery<McdRow>(
        `SELECT MetadataComponentName, MetadataComponentType, ` +
          `RefMetadataComponentName, RefMetadataComponentType ` +
          `FROM MetadataComponentDependency WHERE MetadataComponentType = '${type}'`,
        2000,
      );
      for (const r of rows) {
        if (!r.MetadataComponentName || !r.RefMetadataComponentName) continue;
        edges.push({
          connectionId,
          fromType: r.MetadataComponentType,
          fromName: r.MetadataComponentName,
          toType: r.RefMetadataComponentType,
          toName: r.RefMetadataComponentName,
          source: 'org',
        });
      }
      if (rows.length === 2000) {
        warnings.push(
          `MetadataComponentDependency for ${type} hit the 2000-row API cap; the org graph for this type may be incomplete (extractor edges still apply).`,
        );
      }
    } catch (err) {
      // Common: feature not enabled, or type not supported by MCD.
      log('info', 'MetadataComponentDependency query failed (continuing without)', {
        type,
        err: String(err instanceof Error ? err.message : err),
      });
      warnings.push(`org dependency data unavailable for ${type}`);
    }
  }
  return { edges, warnings };
}
