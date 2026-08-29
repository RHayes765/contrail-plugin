import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ContrailDb } from './core/db.js';
import { KeychainTokenStore, type TokenStore } from './core/keychain.js';
import { AuditLog } from './core/audit.js';
import { loadConfig, type ContrailConfig } from './core/config.js';
import { ConnectFlowManager, type FlowOps } from './connect/flow.js';
import { AccessTokenManager } from './salesforce/tokens.js';
import { SnapshotStore } from './snapshot/store.js';
import { SnapshotEngine } from './snapshot/engine.js';
import { DeployEngine } from './deploy/engine.js';
import { ApprovalPageServer } from './deploy/approval.js';
import { registerTools, type ToolDeps } from './tools/register.js';
import { registerMetadataTools } from './tools/metadata.js';
import { registerDiffTools } from './tools/diff.js';
import { registerDataTools } from './tools/data.js';
import { registerDeployTools } from './tools/deploy.js';

import { ENGINE_VERSION } from './core/version.js';

export const SERVER_NAME = 'contrail-engine';
export const SERVER_VERSION = ENGINE_VERSION;

export function createDeps(overrides?: {
  db?: ContrailDb;
  tokens?: TokenStore;
  config?: ContrailConfig;
  flowOps?: FlowOps;
  store?: SnapshotStore;
  approvals?: ApprovalPageServer;
}): ToolDeps {
  const db = overrides?.db ?? new ContrailDb();
  const tokens = overrides?.tokens ?? new KeychainTokenStore();
  const config = overrides?.config ?? loadConfig();
  const audit = new AuditLog(db);
  const flows = new ConnectFlowManager(db, tokens, audit, config, overrides?.flowOps);
  const tokenMgr = new AccessTokenManager(db, tokens, config);
  const store = overrides?.store ?? new SnapshotStore();
  const engine = new SnapshotEngine(db, store, tokenMgr, config, audit);
  const deploys = new DeployEngine(db, store, tokenMgr, config, audit, overrides?.approvals);
  return { db, tokens, audit, config, flows, tokenMgr, store, engine, deploys };
}

/**
 * Build a fully wired MCP server instance. Transport-agnostic: index.ts
 * attaches stdio by default or streamable HTTP behind --http.
 */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, deps);
  registerMetadataTools(server, deps);
  registerDiffTools(server, deps);
  registerDataTools(server, deps);
  registerDeployTools(server, deps);
  return server;
}
