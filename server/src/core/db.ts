import Database from 'better-sqlite3';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ContrailError } from './errors.js';
import { dbPath } from './paths.js';
import { normalizeGrants, type GrantSet } from './grants.js';

// ── split-brain guard ────────────────────────────────────────────────────
//
// On this machine class (MSIX-packaged hosts), two processes can open "the
// same" database path through DIFFERENT filesystem views: a containerized
// process gets a copy-on-write overlay clone while an outside process keeps
// the real file. Both are self-consistent, SQLite's locking never meets, and
// interleaved checkpoints from the two lineages corrupt the shared pages —
// this destroyed a real database on 2026-08-26.
//
// The guard: stamp a 31-bit hash of the file's OS identity into PRAGMA
// application_id — a header slot, so it needs no table and works at every
// schema version either engine can open. A COW clone (or restored backup) is
// a physically different file with a different id, so a forked view fails the
// check on its next open, BEFORE any pragma or migration writes. A deliberate
// replacement (restore, copied-in backup) re-stamps by dropping a marker file
// `<db>.adopt` next to the database.
//
// Identity per platform: on Windows, volume serial + NTFS file id — both
// stable across reboots, and the overlay clone is a different file id. On
// macOS/Linux, the inode ONLY: st_dev there is assigned at mount time and
// renumbers across reboots and OS updates (a macOS update locked out a real
// install on 2026-11-02), while every real copy or restore gets a new inode —
// so dev adds false positives and no protection. POSIX stamps written by the
// old dev:ino formula are upgraded in place when they still match
// (reconcileLineage's 'restamp'), never refused.

/** FNV-1a over an identity string, folded to a positive 31-bit non-zero int. */
function fnvStamp(identity: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h & 0x7fffffff;
  return h === 0 ? 1 : h;
}

/**
 * The file's current-formula stamp plus, on POSIX, the retired dev:ino one.
 * Null when the guard degrades off (stat failure, or filesystems that report
 * no inode). Exported for tests; `platform` is injectable for the same reason.
 */
export function identityStamps(
  file: string,
  platform: NodeJS.Platform = process.platform,
): { current: number; legacy: number | null } | null {
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(file, { bigint: true });
  } catch {
    return null;
  }
  if (stat.ino === 0n) return null; // non-NTFS / unsupported: guard degrades off
  if (platform === 'win32') {
    return { current: fnvStamp(`${stat.dev}:${stat.ino}`), legacy: null };
  }
  return { current: fnvStamp(`${stat.ino}`), legacy: fnvStamp(`${stat.dev}:${stat.ino}`) };
}

export type LineageVerdict = 'ok' | 'adopt' | 'restamp' | 'mismatch';

/**
 * Pure arbitration, so every branch is unit-testable on any platform.
 * 'restamp' fires only when the stored stamp matches the old, STRICTER
 * formula against the file's current identity — provably the same file,
 * just stamped before the formula dropped dev.
 */
export function reconcileLineage(
  stored: number,
  stamps: { current: number; legacy: number | null },
  adoptMarkerPresent: boolean,
): LineageVerdict {
  if (stored === stamps.current) return 'ok';
  if (stored === 0 || adoptMarkerPresent) return 'adopt';
  if (stamps.legacy !== null && stored === stamps.legacy) return 'restamp';
  return 'mismatch';
}

/** Throws before ANY write when the opened file is not the stamped lineage. */
function assertDbLineage(db: Database.Database): void {
  const stamps = identityStamps(db.name);
  if (stamps === null) return;
  const stored = db.pragma('application_id', { simple: true }) as number;
  const adoptMarker = `${db.name}.adopt`;
  switch (reconcileLineage(stored, stamps, fs.existsSync(adoptMarker))) {
    case 'ok':
      return;
    case 'adopt':
      // Never stamped (pre-guard database or fresh file), or a deliberate
      // replacement announced via the marker: adopt this file as the lineage.
      db.pragma(`application_id = ${stamps.current}`);
      try {
        fs.rmSync(adoptMarker, { force: true });
      } catch {
        /* marker cleanup is best-effort */
      }
      return;
    case 'restamp':
      db.pragma(`application_id = ${stamps.current}`);
      return;
    case 'mismatch':
      throw new ContrailError(
        `This database file is not the one this data directory last used — it is a copy ` +
          `(restored backup, or an MSIX-virtualized overlay view of ${db.name}). Writes are ` +
          `refused to prevent a split-brain fork. If this replacement was deliberate, create ` +
          `an empty file named "${adoptMarker}" and reopen.`,
        'db_lineage_mismatch',
      );
  }
}
import type {
  ArtifactRecord,
  AuditEvent,
  ConnectionRecord,
  DependencyEdge,
  DeployRequestKind,
  DeployRequestRecord,
  OrgType,
} from './types.js';

const SCHEMA_VERSION = 5;

/**
 * Local SQLite store: connection metadata and the audit log (P0.1); the
 * artifact index, dependency graph, and deploy requests join it in later
 * milestones. Stable UUIDs and workspace_id columns from day one so the data
 * survives into the desktop app (spec §6).
 */
export class ContrailDb {
  private readonly db: Database.Database;

  constructor(filePath: string = dbPath()) {
    this.db = new Database(filePath);
    try {
      // The lineage check runs FIRST — before WAL mode, before migrations —
      // so a mismatched view is refused without writing to the database.
      assertDbLineage(this.db);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.migrate();
    } catch (err) {
      // A refused open must not leak the handle — a locked file with no
      // owner object is its own incident.
      this.db.close();
      throw err;
    }
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current >= SCHEMA_VERSION) return;
    const tx = this.db.transaction(() => {
      if (current < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS connections (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            alias         TEXT NOT NULL UNIQUE COLLATE NOCASE,
            instance_url  TEXT NOT NULL,
            login_url     TEXT NOT NULL,
            org_id        TEXT NOT NULL,
            org_name      TEXT,
            org_type      TEXT NOT NULL,
            is_sandbox    INTEGER NOT NULL,
            username      TEXT,
            user_id       TEXT,
            grants_json   TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            last_used_at  TEXT
          );
          CREATE TABLE IF NOT EXISTS audit_events (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            ts            TEXT NOT NULL,
            event_type    TEXT NOT NULL,
            connection_id TEXT,
            tool          TEXT,
            outcome       TEXT NOT NULL,
            detail_json   TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (ts);
          CREATE INDEX IF NOT EXISTS idx_audit_connection ON audit_events (connection_id);
        `);
      }
      if (current < 2) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS artifacts (
            id                 TEXT PRIMARY KEY,
            workspace_id       TEXT NOT NULL DEFAULT 'default',
            connection_id      TEXT NOT NULL,
            type               TEXT NOT NULL,
            api_name           TEXT NOT NULL,
            file_path          TEXT,
            content_hash       TEXT,
            last_modified_date TEXT,
            last_modified_by   TEXT,
            retrieved_at       TEXT NOT NULL,
            UNIQUE (connection_id, type, api_name)
          );
          CREATE INDEX IF NOT EXISTS idx_artifacts_conn_type ON artifacts (connection_id, type);
          CREATE TABLE IF NOT EXISTS dependency_edges (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            connection_id TEXT NOT NULL,
            from_type     TEXT NOT NULL,
            from_name     TEXT NOT NULL,
            to_type       TEXT NOT NULL,
            to_name       TEXT NOT NULL,
            source        TEXT NOT NULL,
            UNIQUE (connection_id, from_type, from_name, to_type, to_name, source)
          );
          CREATE INDEX IF NOT EXISTS idx_edges_from ON dependency_edges (connection_id, from_type, from_name);
          CREATE INDEX IF NOT EXISTS idx_edges_to ON dependency_edges (connection_id, to_type, to_name);
          CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
            api_name, type, content, connection_id UNINDEXED, artifact_id UNINDEXED
          );
        `);
      }
      if (current < 3) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS deploy_requests (
            id                TEXT PRIMARY KEY,
            workspace_id      TEXT NOT NULL DEFAULT 'default',
            connection_id     TEXT NOT NULL,
            kind              TEXT NOT NULL,
            confirmation_code TEXT NOT NULL,
            status            TEXT NOT NULL,
            created_at        TEXT NOT NULL,
            expires_at        TEXT NOT NULL,
            executed_at       TEXT,
            payload_path      TEXT,
            payload_json      TEXT,
            summary_json      TEXT NOT NULL,
            validation_id     TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_deploy_requests_conn
            ON deploy_requests (connection_id, kind, status);
        `);
      }
      if (current < 4) {
        // Stores the execution outcome so a late poll after a long deploy
        // still retrieves the result instead of a spurious error.
        this.db.exec(`ALTER TABLE deploy_requests ADD COLUMN result_json TEXT;`);
      }
      if (current < 5) {
        // Brute-force guard: wrong-code guesses against a pending request are
        // counted here and invalidate the code after a threshold.
        this.db.exec(
          `ALTER TABLE deploy_requests ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;`,
        );
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    tx();
  }

  // ── connections ────────────────────────────────────────────────────────

  insertConnection(input: {
    alias: string;
    instanceUrl: string;
    loginUrl: string;
    orgId: string;
    orgName: string | null;
    orgType: OrgType;
    isSandbox: boolean;
    username: string | null;
    userId: string | null;
    grants: GrantSet;
  }): ConnectionRecord {
    const now = new Date().toISOString();
    const rec: ConnectionRecord = {
      id: randomUUID(),
      workspaceId: 'default',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO connections
           (id, workspace_id, alias, instance_url, login_url, org_id, org_name, org_type,
            is_sandbox, username, user_id, grants_json, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.workspaceId,
        rec.alias,
        rec.instanceUrl,
        rec.loginUrl,
        rec.orgId,
        rec.orgName,
        rec.orgType,
        rec.isSandbox ? 1 : 0,
        rec.username,
        rec.userId,
        JSON.stringify(rec.grants),
        rec.createdAt,
        rec.updatedAt,
        rec.lastUsedAt,
      );
    return rec;
  }

  /** Re-auth on an existing alias (e.g. after a sandbox refresh): new tokens/org identity, grants preserved unless changed on the page. */
  updateConnectionAuth(
    id: string,
    input: {
      instanceUrl: string;
      loginUrl: string;
      orgId: string;
      orgName: string | null;
      orgType: OrgType;
      isSandbox: boolean;
      username: string | null;
      userId: string | null;
      grants: GrantSet;
    },
  ): ConnectionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connections SET instance_url = ?, login_url = ?, org_id = ?, org_name = ?,
           org_type = ?, is_sandbox = ?, username = ?, user_id = ?, grants_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.instanceUrl,
        input.loginUrl,
        input.orgId,
        input.orgName,
        input.orgType,
        input.isSandbox ? 1 : 0,
        input.username,
        input.userId,
        JSON.stringify(input.grants),
        now,
        id,
      );
    const rec = this.getConnection(id);
    if (!rec) throw new Error(`connection ${id} vanished during update`);
    return rec;
  }

  updateGrants(id: string, grants: GrantSet): void {
    this.db
      .prepare(`UPDATE connections SET grants_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(grants), new Date().toISOString(), id);
  }

  /** A token refresh can reveal a migrated/renamed My Domain; keep the stored instance current. */
  updateInstanceUrl(id: string, instanceUrl: string): void {
    this.db
      .prepare(`UPDATE connections SET instance_url = ?, updated_at = ? WHERE id = ?`)
      .run(instanceUrl, new Date().toISOString(), id);
  }

  touchLastUsed(id: string): void {
    this.db
      .prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  deleteConnection(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM artifacts WHERE connection_id = ?`).run(id);
      this.db.prepare(`DELETE FROM dependency_edges WHERE connection_id = ?`).run(id);
      this.db.prepare(`DELETE FROM artifact_fts WHERE connection_id = ?`).run(id);
    });
    tx();
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this.db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
    return row ? rowToConnection(row as ConnectionRow) : null;
  }

  getConnectionByAlias(alias: string): ConnectionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM connections WHERE alias = ? COLLATE NOCASE`)
      .get(alias);
    return row ? rowToConnection(row as ConnectionRow) : null;
  }

  /** Resolve a user/agent-supplied reference: alias first, then id. */
  resolveConnection(ref: string): ConnectionRecord | null {
    return this.getConnectionByAlias(ref) ?? this.getConnection(ref);
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM connections ORDER BY alias`).all();
    return (rows as ConnectionRow[]).map(rowToConnection);
  }

  // ── artifacts / search / dependency graph ──────────────────────────────

  /**
   * Replace all artifacts of the given types for a connection in one
   * transaction (a snapshot refresh is authoritative for what it retrieved).
   * `content` feeds the FTS index only; artifact bodies live on disk.
   */
  replaceArtifactsForTypes(
    connectionId: string,
    types: string[],
    artifacts: Array<Omit<ArtifactRecord, 'id' | 'workspaceId'> & { content?: string }>,
  ): void {
    const del = this.db.prepare(
      `DELETE FROM artifacts WHERE connection_id = ? AND type = ?`,
    );
    const delFts = this.db.prepare(
      `DELETE FROM artifact_fts WHERE connection_id = ? AND type = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO artifacts
         (id, workspace_id, connection_id, type, api_name, file_path, content_hash,
          last_modified_date, last_modified_by, retrieved_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = this.db.prepare(
      `INSERT INTO artifact_fts (api_name, type, content, connection_id, artifact_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const t of types) {
        del.run(connectionId, t);
        delFts.run(connectionId, t);
      }
      for (const a of artifacts) {
        const id = randomUUID();
        ins.run(
          id,
          connectionId,
          a.type,
          a.apiName,
          a.filePath,
          a.contentHash,
          a.lastModifiedDate,
          a.lastModifiedBy,
          a.retrievedAt,
        );
        insFts.run(a.apiName, a.type, a.content ?? '', connectionId, id);
      }
    });
    tx();
  }

  /**
   * S46 (member-scoped refresh): replace named rows only, in one
   * transaction. Every row named by `remove` AND every row an incoming
   * artifact would occupy is deleted first — matched by type and
   * case-insensitive api_name, so a case-changed rename never leaves two
   * rows under the case-sensitive UNIQUE key — with its FTS rows; then the
   * incoming artifacts are inserted as replaceArtifactsForTypes inserts
   * them. Every other row keeps its id. The FTS delete is chunked (400 ids)
   * because artifact_id is UNINDEXED: one table scan per chunk.
   * Hand-mirror to the desktop db.ts.
   */
  replaceArtifactRows(
    connectionId: string,
    remove: Array<{ type: string; apiName: string }>,
    artifacts: Array<Omit<ArtifactRecord, 'id' | 'workspaceId'> & { content?: string }>,
  ): { deleted: number; inserted: number } {
    const find = this.db.prepare(
      `SELECT id FROM artifacts WHERE connection_id = ? AND type = ? AND api_name = ? COLLATE NOCASE`,
    );
    const ins = this.db.prepare(
      `INSERT INTO artifacts
         (id, workspace_id, connection_id, type, api_name, file_path, content_hash,
          last_modified_date, last_modified_by, retrieved_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = this.db.prepare(
      `INSERT INTO artifact_fts (api_name, type, content, connection_id, artifact_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((): { deleted: number; inserted: number } => {
      const ids = new Set<string>();
      for (const r of [...remove, ...artifacts]) {
        for (const row of find.all(connectionId, r.type, r.apiName) as Array<{ id: string }>) {
          ids.add(row.id);
        }
      }
      const all = [...ids];
      let deleted = 0;
      for (let i = 0; i < all.length; i += 400) {
        const chunk = all.slice(i, i + 400);
        const marks = chunk.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM artifact_fts WHERE artifact_id IN (${marks})`).run(...chunk);
        deleted += this.db
          .prepare(`DELETE FROM artifacts WHERE id IN (${marks})`)
          .run(...chunk).changes;
      }
      for (const a of artifacts) {
        const id = randomUUID();
        ins.run(
          id,
          connectionId,
          a.type,
          a.apiName,
          a.filePath,
          a.contentHash,
          a.lastModifiedDate,
          a.lastModifiedBy,
          a.retrievedAt,
        );
        insFts.run(a.apiName, a.type, a.content ?? '', connectionId, id);
      }
      return { deleted, inserted: artifacts.length };
    });
    return tx();
  }

  listArtifacts(connectionId: string, type?: string): ArtifactRecord[] {
    const rows = type
      ? this.db
          .prepare(
            `SELECT * FROM artifacts WHERE connection_id = ? AND type = ? ORDER BY api_name`,
          )
          .all(connectionId, type)
      : this.db
          .prepare(`SELECT * FROM artifacts WHERE connection_id = ? ORDER BY type, api_name`)
          .all(connectionId);
    return (rows as ArtifactRow[]).map(rowToArtifact);
  }

  /** Prepared on first use and kept: one validate can look up thousands of names. */
  private getArtifactStatement: Database.Statement | undefined;

  getArtifact(connectionId: string, type: string, apiName: string): ArtifactRecord | null {
    this.getArtifactStatement ??= this.db.prepare(
      `SELECT * FROM artifacts WHERE connection_id = ? AND type = ? AND api_name = ? COLLATE NOCASE`,
    );
    const row = this.getArtifactStatement.get(connectionId, type, apiName);
    return row ? rowToArtifact(row as ArtifactRow) : null;
  }

  /**
   * S46: every row stored under one snapshot file — a document's root row
   * and all its children (one row for a bundle). Hand-mirror to the desktop
   * db.ts.
   */
  listArtifactsByFilePath(connectionId: string, filePath: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts WHERE connection_id = ? AND file_path = ? ORDER BY type, api_name`,
      )
      .all(connectionId, filePath);
    return (rows as ArtifactRow[]).map(rowToArtifact);
  }

  countArtifactsByType(connectionId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM artifacts WHERE connection_id = ? GROUP BY type ORDER BY type`,
      )
      .all(connectionId) as Array<{ type: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  /** Name (LIKE) matches ranked first, then FTS content matches with snippets. */
  searchArtifacts(
    connectionId: string,
    query: string,
    types: string[] | undefined,
    limit: number,
  ): Array<{ type: string; apiName: string; match: 'name' | 'content'; snippet: string | null }> {
    const results: Array<{
      type: string;
      apiName: string;
      match: 'name' | 'content';
      snippet: string | null;
    }> = [];
    const seen = new Set<string>();
    const typeFilter = types?.length ? ` AND type IN (${types.map(() => '?').join(',')})` : '';

    const likeQ = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const nameRows = this.db
      .prepare(
        `SELECT type, api_name FROM artifacts
         WHERE connection_id = ? AND api_name LIKE ? ESCAPE '\\'${typeFilter}
         ORDER BY length(api_name) LIMIT ?`,
      )
      .all(connectionId, likeQ, ...(types?.length ? types : []), limit) as Array<{
      type: string;
      api_name: string;
    }>;
    for (const r of nameRows) {
      seen.add(`${r.type}:${r.api_name}`);
      results.push({ type: r.type, apiName: r.api_name, match: 'name', snippet: null });
    }

    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery && results.length < limit) {
      let ftsRows: Array<{ type: string; api_name: string; snip: string }> = [];
      try {
        ftsRows = this.db
          .prepare(
            `SELECT type, api_name, snippet(artifact_fts, 2, '»', '«', ' … ', 12) AS snip
             FROM artifact_fts
             WHERE artifact_fts MATCH ? AND connection_id = ?${typeFilter}
             LIMIT ?`,
          )
          .all(
            ftsQuery,
            connectionId,
            ...(types?.length ? types : []),
            limit,
          ) as typeof ftsRows;
      } catch {
        // An FTS syntax edge case despite sanitization — name results still stand.
      }
      for (const r of ftsRows) {
        if (seen.has(`${r.type}:${r.api_name}`)) continue;
        results.push({ type: r.type, apiName: r.api_name, match: 'content', snippet: r.snip });
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }

  /**
   * Replace edges from one source whose from_type is in the refreshed set —
   * a refresh is authoritative only for the types it actually re-read, so
   * edges originating from untouched types survive partial refreshes.
   */
  replaceEdges(
    connectionId: string,
    source: 'org' | 'extractor',
    fromTypes: string[],
    edges: DependencyEdge[],
  ): void {
    const del = this.db.prepare(
      `DELETE FROM dependency_edges WHERE connection_id = ? AND source = ? AND from_type = ?`,
    );
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO dependency_edges
         (id, workspace_id, connection_id, from_type, from_name, to_type, to_name, source)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const t of fromTypes) del.run(connectionId, source, t);
      for (const e of edges) {
        ins.run(randomUUID(), connectionId, e.fromType, e.fromName, e.toType, e.toName, source);
      }
    });
    tx();
  }

  /**
   * S46 (member-scoped refresh): in one transaction, drop the extractor
   * edges FROM each re-read component, drop every edge (both sources) FROM
   * each removed one, then insert the new edges as extractor edges. Edges
   * TO those components, and org edges from a re-read one, are untouched.
   * Hand-mirror to the desktop db.ts.
   */
  replaceEdgesFromArtifacts(
    connectionId: string,
    input: {
      refreshed: Array<{ type: string; name: string }>;
      removed: Array<{ type: string; name: string }>;
      edges: DependencyEdge[];
    },
  ): void {
    const delExtractor = this.db.prepare(
      `DELETE FROM dependency_edges
       WHERE connection_id = ? AND source = 'extractor' AND from_type = ? AND from_name = ? COLLATE NOCASE`,
    );
    const delAll = this.db.prepare(
      `DELETE FROM dependency_edges
       WHERE connection_id = ? AND from_type = ? AND from_name = ? COLLATE NOCASE`,
    );
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO dependency_edges
         (id, workspace_id, connection_id, from_type, from_name, to_type, to_name, source)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const r of input.refreshed) delExtractor.run(connectionId, r.type, r.name);
      for (const r of input.removed) delAll.run(connectionId, r.type, r.name);
      for (const e of input.edges) {
        ins.run(randomUUID(), connectionId, e.fromType, e.fromName, e.toType, e.toName, 'extractor');
      }
    });
    tx();
  }

  edgesFrom(connectionId: string, type: string, name: string): DependencyEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dependency_edges
         WHERE connection_id = ? AND from_type = ? AND from_name = ? COLLATE NOCASE`,
      )
      .all(connectionId, type, name);
    return (rows as EdgeRow[]).map(rowToEdge);
  }

  edgesTo(connectionId: string, type: string, name: string): DependencyEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dependency_edges
         WHERE connection_id = ? AND to_type = ? AND to_name = ? COLLATE NOCASE`,
      )
      .all(connectionId, type, name);
    return (rows as EdgeRow[]).map(rowToEdge);
  }

  // ── deploy / dml requests (write-safety two-step, spec §5) ─────────────

  insertDeployRequest(input: {
    connectionId: string;
    kind: DeployRequestKind;
    confirmationCode: string;
    expiresAt: string;
    payloadPath?: string | null;
    payloadJson?: string | null;
    summaryJson: string;
    validationId?: string | null;
  }): DeployRequestRecord {
    const rec: DeployRequestRecord = {
      id: randomUUID(),
      workspaceId: 'default',
      connectionId: input.connectionId,
      kind: input.kind,
      confirmationCode: input.confirmationCode,
      status: 'validated',
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      executedAt: null,
      payloadPath: input.payloadPath ?? null,
      payloadJson: input.payloadJson ?? null,
      summaryJson: input.summaryJson,
      validationId: input.validationId ?? null,
      resultJson: null,
    };
    this.db
      .prepare(
        `INSERT INTO deploy_requests
           (id, workspace_id, connection_id, kind, confirmation_code, status, created_at,
            expires_at, executed_at, payload_path, payload_json, summary_json, validation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.workspaceId,
        rec.connectionId,
        rec.kind,
        rec.confirmationCode,
        rec.status,
        rec.createdAt,
        rec.expiresAt,
        rec.executedAt,
        rec.payloadPath,
        rec.payloadJson,
        rec.summaryJson,
        rec.validationId,
      );
    return rec;
  }

  /** A new validation on the same target invalidates every earlier pending code (spec §5). */
  supersedePendingRequests(connectionId: string, kind: DeployRequestKind): number {
    const result = this.db
      .prepare(
        `UPDATE deploy_requests SET status = 'superseded'
         WHERE connection_id = ? AND kind = ? AND status = 'validated'`,
      )
      .run(connectionId, kind);
    return result.changes;
  }

  /**
   * S45: void ONE still-pending request and store the reason as its result
   * (the execute-time "target moved" guard — re-sending the code replays this
   * text, never "a newer validation replaced it"). Atomic against a concurrent
   * claimRequestForExecution: both UPDATEs predicate on status = 'validated',
   * so exactly one of them can match — a voided request is never also
   * claimed. Returns false when the row was no longer 'validated' (claimed,
   * superseded, expired or locked first), and the caller falls through.
   */
  voidRequestWithResult(id: string, resultJson: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE deploy_requests SET status = 'superseded', result_json = ?
         WHERE id = ? AND status = 'validated'`,
      )
      .run(resultJson, id);
    return result.changes === 1;
  }

  /**
   * S45: claimCode's lazy expiry of ONE request — predicated on status =
   * 'validated' like voidRequestWithResult, so a request another process
   * claimed (the plugin and the desktop share this database) is never
   * flipped back to 'expired' under its running execution. Returns true only
   * when this call expired it; the caller removes the payload and pre-images
   * only then. Hand-mirror to the desktop db.ts beside voidRequestWithResult,
   * together with registerFailedAttempt's status-predicated UPDATEs.
   */
  expireValidatedRequest(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE deploy_requests SET status = 'expired' WHERE id = ? AND status = 'validated'`)
      .run(id);
    return result.changes === 1;
  }

  /**
   * S45: flip every past-due 'validated' request — any connection, any kind —
   * to 'expired' and return the rows so the caller can remove their payloads
   * and pre-images. Expiry used to be lazy (only a claim attempt noticed a
   * stale code, claimCode's path is untouched), so never-executed
   * validations stayed 'validated' forever. ISO-8601 UTC stamps compare
   * lexicographically; RETURNING is supported by the bundled SQLite (3.35+).
   */
  expireStaleValidatedRequests(
    nowIso: string,
  ): Array<{ id: string; payloadPath: string | null }> {
    const rows = this.db
      .prepare(
        `UPDATE deploy_requests SET status = 'expired'
         WHERE status = 'validated' AND expires_at < ?
         RETURNING id, payload_path`,
      )
      .all(nowIso) as Array<{ id: string; payload_path: string | null }>;
    return rows.map((r) => ({ id: r.id, payloadPath: r.payload_path }));
  }

  /** Lookup by code regardless of status; the caller branches on request.status. */
  findRequestByCode(
    connectionId: string,
    kind: DeployRequestKind,
    code: string,
  ): DeployRequestRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM deploy_requests
         WHERE connection_id = ? AND kind = ? AND confirmation_code = ? COLLATE NOCASE
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(connectionId, kind, code.trim());
    return row ? rowToDeployRequest(row as DeployRequestRow) : null;
  }

  /**
   * Atomically claim a validated request for execution. Returns true only for
   * the single caller that flips 'validated'→'executing'; concurrent callers
   * and re-runs get false. This is the single-use guarantee (spec §5) — the
   * code is spent BEFORE the write dispatches, so a failed or duplicated
   * execute can never re-drive it.
   */
  claimRequestForExecution(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE deploy_requests SET status = 'executing' WHERE id = ? AND status = 'validated'`,
      )
      .run(id);
    return result.changes === 1;
  }

  finishDeployRequest(
    id: string,
    status: 'executed' | 'execution_failed',
    resultJson: string,
  ): void {
    this.db
      .prepare(
        `UPDATE deploy_requests SET status = ?, executed_at = ?, result_json = ? WHERE id = ?`,
      )
      .run(status, new Date().toISOString(), resultJson, id);
  }

  /**
   * S46 (re-baseline): amend an EXECUTED request's stored result — the
   * post-deploy re-read replaces the `pending` snapshot block with its
   * outcome. Predicated on status = 'executed'; never touches status or
   * executed_at. Hand-mirror to the desktop db.ts.
   */
  amendDeployRequestResult(id: string, resultJson: string): boolean {
    const result = this.db
      .prepare(`UPDATE deploy_requests SET result_json = ? WHERE id = ? AND status = 'executed'`)
      .run(resultJson, id);
    return result.changes === 1;
  }

  /** S46: one request by id, any status (the desktop db.ts has the same accessor). */
  getDeployRequest(id: string): DeployRequestRecord | null {
    const row = this.db.prepare(`SELECT * FROM deploy_requests WHERE id = ?`).get(id);
    return row ? rowToDeployRequest(row as DeployRequestRow) : null;
  }

  /**
   * S46: requests by connection, creation window or id — newest first
   * (created_at DESC, id DESC, a total order, so `offset` pages without
   * gaps or repeats). `since` and `until` bound created_at inclusively;
   * limit 1–1000, default 200. Hand-mirror to the desktop db.ts.
   */
  queryDeployRequests(filter: {
    connectionId?: string;
    since?: string;
    until?: string;
    id?: string;
    limit?: number;
    offset?: number;
  }): DeployRequestRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.connectionId) {
      clauses.push('connection_id = ?');
      params.push(filter.connectionId);
    }
    if (filter.since) {
      clauses.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      clauses.push('created_at <= ?');
      params.push(filter.until);
    }
    if (filter.id) {
      clauses.push('id = ?');
      params.push(filter.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 200), 1), 1000);
    const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM deploy_requests ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return (rows as DeployRequestRow[]).map(rowToDeployRequest);
  }

  getDeployRequestStatus(id: string): string | null {
    const row = this.db
      .prepare(`SELECT status FROM deploy_requests WHERE id = ?`)
      .get(id) as { status: string } | undefined;
    return row?.status ?? null;
  }

  setDeployRequestPayloadPath(id: string, payloadPath: string): void {
    this.db
      .prepare(`UPDATE deploy_requests SET payload_path = ? WHERE id = ?`)
      .run(payloadPath, id);
  }

  /**
   * S45: re-persist a validated request's summary — the deploy validate
   * writes its revert pre-images AFTER the row exists (the directory is
   * keyed by the request id) and records what it wrote here.
   * S45: hand-mirror to the desktop db.ts with voidRequestWithResult and
   * expireStaleValidatedRequests (engine.ts calls it).
   */
  setDeployRequestSummaryJson(id: string, summaryJson: string): void {
    this.db
      .prepare(`UPDATE deploy_requests SET summary_json = ? WHERE id = ?`)
      .run(summaryJson, id);
  }

  /**
   * S46: the one writer of a PRESENTED request's summary_json — the page
   * view, the justification, a freeze override and the execute-time policy
   * record all go through it, so no write can erase another's keys. Reads
   * the row and writes `patch(summary)` in one IMMEDIATE transaction (the
   * write lock is taken before the read; the plugin and the desktop share
   * this database), and only while the row is still 'validated' — the
   * UPDATE is predicated on that too, so a patch can never land on a
   * claimed, voided or expired row. Returns false, writing nothing, when
   * the row is missing or no longer 'validated'. A summary that is not a
   * JSON object is patched from {}. Hand-mirror to the desktop db.ts.
   */
  patchDeployRequestSummary(
    id: string,
    patch: (summary: Record<string, unknown>) => Record<string, unknown>,
  ): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db
        .prepare(`SELECT summary_json, status FROM deploy_requests WHERE id = ?`)
        .get(id) as { summary_json: string; status: string } | undefined;
      if (!row || row.status !== 'validated') return false;
      const parsed = safeParse(row.summary_json);
      const summary =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const next = JSON.stringify(patch(summary));
      const result = this.db
        .prepare(`UPDATE deploy_requests SET summary_json = ? WHERE id = ? AND status = 'validated'`)
        .run(next, id);
      return result.changes === 1;
    });
    return tx.immediate();
  }

  updateDeployRequestStatus(
    id: string,
    status: 'executed' | 'executing' | 'expired' | 'superseded' | 'execution_failed' | 'locked',
  ): void {
    this.db
      .prepare(`UPDATE deploy_requests SET status = ?, executed_at = ? WHERE id = ?`)
      .run(status, status === 'executed' ? new Date().toISOString() : null, id);
  }

  /**
   * Record a wrong-code guess against the pending validated request for this
   * connection+kind (brute-force guard). Increments its counter; once the
   * threshold is reached the request is locked so even the correct code can no
   * longer execute it — the human must re-validate. Returns what happened so
   * the caller can shape the refusal message and audit.
   * S45: both UPDATEs predicate on status = 'validated' (the plugin and the
   * desktop share this database): a row another process claimed between the
   * SELECT and the UPDATE is never flipped to 'locked' under its running
   * execution — the caller then deletes nothing, because locked is reported
   * only when the lock UPDATE matched. Hand-mirror to the desktop db.ts with
   * expireValidatedRequest.
   */
  registerFailedAttempt(
    connectionId: string,
    kind: DeployRequestKind,
    maxAttempts: number,
  ): { pendingExisted: boolean; locked: boolean; attemptsRemaining: number; requestId?: string; payloadPath?: string | null } {
    const row = this.db
      .prepare(
        `SELECT id, failed_attempts, payload_path FROM deploy_requests
         WHERE connection_id = ? AND kind = ? AND status = 'validated'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(connectionId, kind) as
      | { id: string; failed_attempts: number; payload_path: string | null }
      | undefined;
    if (!row) return { pendingExisted: false, locked: false, attemptsRemaining: 0 };

    const bumped = this.db
      .prepare(
        `UPDATE deploy_requests SET failed_attempts = failed_attempts + 1
         WHERE id = ? AND status = 'validated' RETURNING failed_attempts`,
      )
      .get(row.id) as { failed_attempts: number } | undefined;
    // No longer pending (claimed, voided or expired since the SELECT).
    if (!bumped) return { pendingExisted: false, locked: false, attemptsRemaining: 0 };
    const attempts = bumped.failed_attempts;
    if (attempts >= maxAttempts) {
      const locked = this.db
        .prepare(`UPDATE deploy_requests SET status = 'locked' WHERE id = ? AND status = 'validated'`)
        .run(row.id);
      if (locked.changes !== 1) {
        return { pendingExisted: false, locked: false, attemptsRemaining: 0 };
      }
      return {
        pendingExisted: true,
        locked: true,
        attemptsRemaining: 0,
        requestId: row.id,
        payloadPath: row.payload_path,
      };
    }
    return {
      pendingExisted: true,
      locked: false,
      attemptsRemaining: maxAttempts - attempts,
      requestId: row.id,
    };
  }

  /** Payload zips of superseded requests, so the caller can delete them. */
  takeSupersededPayloadPaths(connectionId: string, kind: DeployRequestKind): string[] {
    const rows = this.db
      .prepare(
        `SELECT payload_path FROM deploy_requests
         WHERE connection_id = ? AND kind = ? AND status = 'superseded' AND payload_path IS NOT NULL`,
      )
      .all(connectionId, kind) as Array<{ payload_path: string }>;
    return rows.map((r) => r.payload_path);
  }

  // ── audit ──────────────────────────────────────────────────────────────

  insertAuditEvent(input: {
    eventType: string;
    connectionId?: string | null;
    tool?: string | null;
    outcome: 'success' | 'refused' | 'error';
    detail?: Record<string, unknown> | null;
  }): AuditEvent {
    const evt: AuditEvent = {
      id: randomUUID(),
      workspaceId: 'default',
      ts: new Date().toISOString(),
      eventType: input.eventType,
      connectionId: input.connectionId ?? null,
      tool: input.tool ?? null,
      outcome: input.outcome,
      detail: input.detail ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, ts, event_type, connection_id, tool, outcome, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evt.id,
        evt.workspaceId,
        evt.ts,
        evt.eventType,
        evt.connectionId,
        evt.tool,
        evt.outcome,
        evt.detail ? JSON.stringify(evt.detail) : null,
      );
    return evt;
  }

  /**
   * S46 widens the filter: `until` (inclusive), `requestId` (events whose
   * detail names that request — as its requestId, or in a requestIds list
   * such as the expiry sweep's; validated as a UUID first, so neither LIKE
   * pattern holds a wildcard) and `eventType` (exact, or every type under a
   * prefix ending in a dot). `since` and `until` are compared as the instants
   * they name (stored ts is always toISOString, so each bound is re-formatted
   * the same way); a bound that is not a timestamp is refused. A malformed
   * requestId or eventType is refused, never matched loosely. Hand-mirror to
   * the desktop db.ts.
   */
  queryAuditEvents(filter: {
    connectionId?: string;
    since?: string;
    until?: string;
    requestId?: string;
    eventType?: string;
    limit?: number;
  }): AuditEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const bound = (name: 'since' | 'until', v: string): string => {
      const ms = Date.parse(v);
      if (Number.isNaN(ms)) {
        throw new ContrailError(
          `${name} must be an ISO 8601 timestamp (for example 2026-11-17T09:00:00Z), got "${v}".`,
          'bad_timestamp',
        );
      }
      return new Date(ms).toISOString();
    };
    if (filter.connectionId) {
      clauses.push('connection_id = ?');
      params.push(filter.connectionId);
    }
    if (filter.since) {
      clauses.push('ts >= ?');
      params.push(bound('since', filter.since));
    }
    if (filter.until) {
      clauses.push('ts <= ?');
      params.push(bound('until', filter.until));
    }
    if (filter.requestId !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filter.requestId)) {
        throw new ContrailError(
          `request id must be the request_id a validate or propose result returned (a UUID), got "${filter.requestId}"`,
          'bad_request_id',
        );
      }
      clauses.push('(detail_json LIKE ? OR detail_json LIKE ?)');
      params.push(`%"requestId":"${filter.requestId}"%`, `%"requestIds":[%"${filter.requestId}"%`);
    }
    if (filter.eventType !== undefined) {
      if (!/^[a-z_]+\.[a-z_]*$/.test(filter.eventType)) {
        throw new ContrailError(
          `event type must look like policy.refused, or a prefix ending in a dot such as policy., got "${filter.eventType}"`,
          'bad_event_type',
        );
      }
      if (filter.eventType.endsWith('.')) {
        // substr, not LIKE: '_' is a LIKE wildcard and is legal in a type.
        clauses.push('substr(event_type, 1, ?) = ?');
        params.push(filter.eventType.length, filter.eventType);
      } else {
        clauses.push('event_type = ?');
        params.push(filter.eventType);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit);
    return (rows as AuditRow[]).map(rowToAudit);
  }

  /**
   * S41: OPPORTUNISTIC participation in the desktop app's cross-process
   * snapshot lease. The app_locks table is desktop-owned (its v6 migration);
   * the plugin's schema is frozen at v5 and NEVER creates it — on a machine
   * without the desktop app the table is absent and acquisition trivially
   * succeeds (in-process serialisation still holds via the refresh chain).
   * Where the table exists, this mirrors the desktop's semantics exactly:
   * expired or self-held locks are taken over; a live foreign lock refuses.
   */
  tryAcquireAppLock(name: string, holder: string, ttlMs: number): boolean {
    if (!this.hasAppLocksTable()) return true;
    const now = Date.now();
    const tx = this.db.transaction((): boolean => {
      const row = this.db
        .prepare(`SELECT holder, expires_at FROM app_locks WHERE name = ?`)
        .get(name) as { holder: string; expires_at: string } | undefined;
      if (row && row.holder !== holder && new Date(row.expires_at).getTime() > now) {
        return false;
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO app_locks (name, holder, pid, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          holder,
          process.pid,
          new Date(now).toISOString(),
          new Date(now + ttlMs).toISOString(),
        );
      return true;
    });
    return tx();
  }

  releaseAppLock(name: string, holder: string): void {
    if (!this.hasAppLocksTable()) return;
    this.db.prepare(`DELETE FROM app_locks WHERE name = ? AND holder = ?`).run(name, holder);
  }

  private appLocksTableKnown: boolean | null = null;
  private hasAppLocksTable(): boolean {
    // Probed once per process, re-probed only while absent (the desktop may
    // create it at any time; it is never dropped).
    if (this.appLocksTableKnown === true) return true;
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_locks'`)
      .get();
    this.appLocksTableKnown = row !== undefined;
    return this.appLocksTableKnown;
  }

  close(): void {
    this.db.close();
  }
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  alias: string;
  instance_url: string;
  login_url: string;
  org_id: string;
  org_name: string | null;
  org_type: string;
  is_sandbox: number;
  username: string | null;
  user_id: string | null;
  grants_json: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface AuditRow {
  id: string;
  workspace_id: string;
  ts: string;
  event_type: string;
  connection_id: string | null;
  tool: string | null;
  outcome: string;
  detail_json: string | null;
}

function rowToConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    alias: row.alias,
    instanceUrl: row.instance_url,
    loginUrl: row.login_url,
    orgId: row.org_id,
    orgName: row.org_name,
    orgType: row.org_type as OrgType,
    isSandbox: row.is_sandbox === 1,
    username: row.username,
    userId: row.user_id,
    grants: normalizeGrants(safeParse(row.grants_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function rowToAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ts: row.ts,
    eventType: row.event_type,
    connectionId: row.connection_id,
    tool: row.tool,
    outcome: row.outcome as AuditEvent['outcome'],
    detail: row.detail_json ? (safeParse(row.detail_json) as Record<string, unknown>) : null,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

interface ArtifactRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  type: string;
  api_name: string;
  file_path: string | null;
  content_hash: string | null;
  last_modified_date: string | null;
  last_modified_by: string | null;
  retrieved_at: string;
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    type: row.type,
    apiName: row.api_name,
    filePath: row.file_path,
    contentHash: row.content_hash,
    lastModifiedDate: row.last_modified_date,
    lastModifiedBy: row.last_modified_by,
    retrievedAt: row.retrieved_at,
  };
}

interface EdgeRow {
  connection_id: string;
  from_type: string;
  from_name: string;
  to_type: string;
  to_name: string;
  source: string;
}

function rowToEdge(row: EdgeRow): DependencyEdge {
  return {
    connectionId: row.connection_id,
    fromType: row.from_type,
    fromName: row.from_name,
    toType: row.to_type,
    toName: row.to_name,
    source: row.source as DependencyEdge['source'],
  };
}

interface DeployRequestRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  kind: string;
  confirmation_code: string;
  status: string;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  payload_path: string | null;
  payload_json: string | null;
  summary_json: string;
  validation_id: string | null;
  result_json: string | null;
}

function rowToDeployRequest(row: DeployRequestRow): DeployRequestRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    kind: row.kind as DeployRequestRecord['kind'],
    confirmationCode: row.confirmation_code,
    status: row.status as DeployRequestRecord['status'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    payloadPath: row.payload_path,
    payloadJson: row.payload_json,
    summaryJson: row.summary_json,
    validationId: row.validation_id,
    resultJson: row.result_json,
  };
}

/** Sanitize a user query into FTS5 MATCH syntax: quoted prefix tokens, AND-joined. */
function buildFtsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replaceAll('"', '').trim())
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}
