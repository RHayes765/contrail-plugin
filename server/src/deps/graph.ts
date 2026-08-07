import type { ContrailDb } from '../core/db.js';
import type { DependencyEdge } from '../core/types.js';

/**
 * Graph queries over dependency_edges: neighborhood, reverse deps, and
 * blast radius (spec §4 get_dependencies).
 */

export interface GraphNode {
  type: string;
  name: string;
  depth: number;
}

export interface GraphResult {
  root: { type: string; name: string };
  direction: 'uses' | 'used_by' | 'both';
  depth: number;
  nodes: GraphNode[];
  edges: Array<{
    from: string;
    to: string;
    sources: string[];
  }>;
  /** used_by counts per type at depth 1 — "what breaks if I change this". */
  blast_radius: Record<string, number>;
  /** Present only when blast_radius is empty, so "unused" is never ambiguous. */
  blast_radius_note?: string;
  truncated: boolean;
}

const MAX_NODES = 200;

export function queryDependencies(
  db: ContrailDb,
  connectionId: string,
  type: string,
  name: string,
  direction: 'uses' | 'used_by' | 'both',
  depth: number,
): GraphResult {
  const nodes = new Map<string, GraphNode>();
  const edgeMap = new Map<string, { from: string; to: string; sources: Set<string> }>();
  let truncated = false;

  const rootKey = key(type, name);
  const frontier: Array<{ type: string; name: string; depth: number }> = [
    { type, name, depth: 0 },
  ];
  const visited = new Set<string>([rootKey]);

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    if (current.depth >= depth) continue;

    const expansions: Array<{ edge: DependencyEdge; nextType: string; nextName: string }> = [];
    if (direction === 'uses' || direction === 'both') {
      for (const e of db.edgesFrom(connectionId, current.type, current.name)) {
        expansions.push({ edge: e, nextType: e.toType, nextName: e.toName });
      }
    }
    if (direction === 'used_by' || direction === 'both') {
      for (const e of db.edgesTo(connectionId, current.type, current.name)) {
        expansions.push({ edge: e, nextType: e.fromType, nextName: e.fromName });
      }
    }

    for (const { edge, nextType, nextName } of expansions) {
      const ek = `${key(edge.fromType, edge.fromName)}→${key(edge.toType, edge.toName)}`;
      const existing = edgeMap.get(ek);
      if (existing) existing.sources.add(edge.source);
      else {
        edgeMap.set(ek, {
          from: `${edge.fromType}:${edge.fromName}`,
          to: `${edge.toType}:${edge.toName}`,
          sources: new Set([edge.source]),
        });
      }

      const nk = key(nextType, nextName);
      if (visited.has(nk)) continue;
      if (nodes.size >= MAX_NODES) {
        truncated = true;
        continue;
      }
      visited.add(nk);
      nodes.set(nk, { type: nextType, name: nextName, depth: current.depth + 1 });
      frontier.push({ type: nextType, name: nextName, depth: current.depth + 1 });
    }
  }

  // Count distinct dependents — the same logical edge is stored once per
  // source (extractor + org API), and a dependent is one blast, not two.
  const blast: Record<string, number> = {};
  const seenDependents = new Set<string>();
  for (const e of db.edgesTo(connectionId, type, name)) {
    const k = key(e.fromType, e.fromName);
    if (seenDependents.has(k)) continue;
    seenDependents.add(k);
    blast[e.fromType] = (blast[e.fromType] ?? 0) + 1;
  }

  return {
    root: { type, name },
    direction,
    depth,
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
    edges: [...edgeMap.values()].map((e) => ({ from: e.from, to: e.to, sources: [...e.sources] })),
    blast_radius: blast,
    ...(Object.keys(blast).length === 0
      ? {
          blast_radius_note:
            'No known dependents in the local graph. Either nothing references this artifact, ' +
            'or edges into it are not yet extracted for its type — treat "unused" as ' +
            'unconfirmed for anything you plan to delete.',
        }
      : {}),
    truncated,
  };
}

function key(type: string, name: string): string {
  return `${type}:${name}`.toLowerCase();
}
