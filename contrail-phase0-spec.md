# Contrail Phase 0 — Engine-as-Plugin Spec

*Working name: **Contrail**. Standalone spec for the middle-ground release: the Contrail engine shipped as a Claude plugin (local MCP server + skill), run inside Claude Desktop. Companion docs: `contrail-build-spec.md` (the full desktop app this precedes). 2026-08-06, rev 2 (adds background section).*

---

## 0. Background — what Contrail is

**Contrail is an AI harness built for Salesforce work.** A harness is everything wrapped around a model that turns it into an agent — the tool loop, context management, connections, permissions. General-purpose harnesses (Claude Desktop, Cursor) treat Salesforce as just another connector; Salesforce's own AI tooling (Agentforce Vibes, the DX MCP Server) assumes a developer, a developer machine, and the Salesforce ecosystem as the whole world. Contrail is the thing in the middle: an AI workspace where **the Salesforce org is the first-class object**.

The core ideas, in brief:

- **Org connections over server configs.** Authenticate an org once (interactive OAuth, as yourself); the harness owns that connection and injects it into every capability. No per-MCP-server, per-org credential duplication.
- **Five explicit per-connection grants** — `metadata_read`, `metadata_write`, `diagnostics_read`, `data_read`, `data_write` — set by a human, enforced server-side, and surfaced to the agent so it knows exactly what it can do where. Every write, in every environment, requires human approval; that invariant is not configurable.
- **A real metadata engine, not MCP wrappers.** Out-of-the-box MCP servers can't pull a flow's XML or an Apex class body. Contrail's engine is a first-party Metadata/Tooling API client: retrieve and snapshot metadata, build the dependency graph, compute semantic diffs (including sandbox-vs-prod, cross-org), and run validated deploys — with the deterministic work done in code, so the model reasons over pre-computed structure instead of grinding raw XML. MCP remains the surface for data access, ecosystem connectors (Slack, Jira, Google), and extensibility — a surface, not the substrate.
- **Cross-ecosystem by design.** Salesforce work never happens in a vacuum; the same session reads the Jira ticket, pulls the flow, proposes the fix, drafts the client email.

**Who it's for:** consultants/SIs (many clients × many orgs; the credential-setup problem is their daily life) and in-house teams at larger companies (dozens of sandboxes, admins who will never open VS Code).

**Roadmap:** Phase 0 (this spec) ships the engine as a Claude plugin inside Claude Desktop. The standalone desktop app (`contrail-build-spec.md`) follows, wrapping the proven engine in purpose-built UI — metadata browser, diff viewer, deploy review screen — with project↔org bindings and its own model access. A team/web edition is the eventual growth path. The name: a contrail is cloud imagery without Salesforce's cloud — the trail left behind by harnessed flight.

## 1. Purpose and strategy

Ship the hardest, most transplantable layer of Contrail first — the metadata engine and connection manager — as a **Claude plugin**: a local stdio MCP server plus a skill carrying the house rules. Users run it inside Claude Desktop.

Why this is the right first move:

- **No model-billing problem.** Usage inside Claude Desktop is first-party and draws from the user's Claude subscription. No API keys, no verified-app program, no token cost engineering required to validate the product.
- **No app to build.** No Electron shell, no UI, no updater. Weeks to usable, not months.
- **The moat gets built either way.** The engine (Metadata/Tooling API client, snapshots, dependency graph, diff, deploy pipeline) is the part a generic harness can never replicate — and it transplants into the desktop app unchanged. Phase 0 rents Anthropic's harness while building it.
- **Validation before commitment.** Real consultants doing real client work inside the plugin tells us which workflows matter before we spend months on chrome.

**What Phase 0 deliberately accepts losing** (and what the desktop app exists to add later): the metadata browser, visual diff viewer, and deploy review screen; harness-level context management; connection-manager UX beyond a localhost page.

## 2. Deliverable shape

A Claude **plugin** containing:

1. **The Contrail Engine MCP server** — TypeScript/Node, local stdio transport. All Salesforce capability lives here.
2. **A skill** — the house rules: never guess an org (every action names its target connection); validate before deploy; summarize destructive changes prominently; check `get_permissions` rather than discovering grants by failure; deploy discipline (checkOnly → review → confirm).

**Transport-agnostic from the first commit.** stdio for Phase 0; streamable HTTP behind a flag. The team step is the same codebase shipped as a **self-hosted Docker image**: a consultancy runs it on their own infra, tokens never touch us, and each user still OAuths individually so org-side audit attribution survives. Hosted-by-us is explicitly deferred — it reintroduces the credential-custodian burden the local-first decision removed, and amounts to the future web edition's connection manager arriving early.

**In-org (invocable Apex) MCP: rejected as the engine home.** No native Metadata API access from Apex (SOAP wrappers or named-credential callouts only, with per-org setup); governor limits preclude snapshot/graph/diff workloads; per-org managed-package installs are a heavier ask on client IT than a local tool with OAuth; and an in-org engine can never do cross-org work — it kills the sandbox-vs-prod diff. In-org MCP servers remain consumable as *data-layer* servers alongside the engine.

## 3. Org connections

### Connect flow (multi-org, incremental)

Connecting an org is an MCP tool, not an install-time wizard:

1. User asks to connect an org mid-conversation → agent calls `connect_org`.
2. The server starts a localhost listener and opens the system browser to the correct login endpoint (production/dev → login.salesforce.com, sandbox → test.salesforce.com, or a supplied My Domain URL). OAuth 2.0 authorization-code + PKCE against the Contrail multi-org connected app (public client — no secret ships).
3. The user logs in **as themselves** — preserving org-side audit attribution per human.
4. The OAuth callback lands on a **local completion page served by the server**: set the label, confirm detected org type (`SELECT IsSandbox FROM Organization`), tick the five grant checkboxes, save.
5. Refresh token → OS keychain under a per-connection alias. Connection metadata (alias, instance URL, org id, org type, grants) → local config store.

**Grants are set on the completion page and only there — never via the agent or tool arguments.** The model cannot (and cannot be prompt-injected to) choose its own permissions. Changing grants later re-opens the same page (`manage_connection` tool returns the localhost URL).

Adding an org next quarter is the same sentence. A sandbox refresh (which invalidates tokens) is a re-run of the flow on the existing alias. `disconnect_org` revokes the token and removes the entry.

### Permission model (inherited from the main spec, enforced server-side)

Five independent boolean grants per connection: `metadata_read`, `metadata_write` (requires `metadata_read`), `diagnostics_read`, `data_read`, `data_write` (requires `data_read`). Every tool maps to exactly one required grant; the server independently classifies every operation and refuses anything outside the connection's grants — this is the main spec's layer-2 gate, verbatim. Deploy validation is available with `metadata_write` alone, but test-failure assertion detail is classified diagnostic and withheld without `diagnostics_read`.

### Scoping (large-team reality: ~80 staff, 3–6 per client)

Nothing is global. Connections are created on demand, per engagement — each person holds exactly the orgs for their current clients, nothing to scroll past, nothing to clean up when rolling off. An optional per-project connection list (aliases, URLs, org types, grants — never tokens) may live in a client project's own repo or Claude Project for the handful of people on that engagement; the agent can walk a newly staffed teammate through authorizing each listed org, one browser login apiece, inheriting the grant settings already decided. No org-wide sharing. sf CLI auth import: **cut** (revisit if wanted).

## 4. Tool surface (v0)

| Tool | Grant | Notes |
|---|---|---|
| `connect_org` / `disconnect_org` / `manage_connection` | — | Connection lifecycle; grants set on localhost page only |
| `list_connections` / `get_permissions` | — | Zero-cost; full grants matrix incl. what is NOT granted, so the agent never discovers permissions by trial and error |
| `list_metadata` / `retrieve_metadata` | `metadata_read` | Types list; artifact retrieve (Flow XML, Apex bodies via Tooling `SELECT Body FROM ApexClass`, objects/fields, etc.) returned as slices with a one-hop dependency summary |
| `describe_schema` | `metadata_read` | Object/field describe |
| `search_metadata` | `metadata_read` | Name/content search over the local snapshot index |
| `get_dependencies` | `metadata_read` | Neighborhood / reverse-deps / blast-radius from the local graph |
| `diff_orgs` / `diff_artifact` | `metadata_read` (both connections) | Semantic diff over snapshots; cross-org requires the grant on both |
| `refresh_snapshot` | `metadata_read` | Manifest-driven re-retrieve; also runs on-demand staleness checks |
| `soql_query` / `get_record` | `data_read` | Row-capped, count included |
| `dml_propose` / `dml_execute` | `data_write` | Two-step (see §5) |
| `get_debug_logs` / `get_flow_errors` / `run_apex_tests` (test transactions commit no DML, hence no approval ritual) | `diagnostics_read` | Incidental record data accepted knowingly |
| `validate_deploy` | `metadata_write` | Builds package + `checkOnly=true`; returns change summary, blast radius, validation results, and a confirmation code |
| `execute_deploy` | `metadata_write` | Requires the confirmation code from `validate_deploy` (see §5) |
| `get_audit_log` | — | Local, exportable |

Engine internals behind these tools — snapshot storage, normalized artifact index, reference extractor + dependency graph, semantic diff, deploy packaging — are specified in the main spec §5 and are identical here; that is the point.

## 5. Write safety without a UI

The approval invariant (every write requires a human decision, every environment) is implemented as **two-step confirmation**, since Phase 0 has no review screen:

1. `validate_deploy` (or `dml_propose`) returns: target connection (unmissable), component change list, destructive changes flagged, validation/test results, blast radius, and a short **confirmation code**.
2. `execute_deploy` (or `dml_execute`) requires that code as an argument. The skill instructs the agent to display the summary and ask the human to provide the code — the human must read and repeat, which is the approval semantic without the screen.
3. Codes are single-use, expire (~1h), and are invalidated by any new validation on the same target.

MCP **elicitation** is the cleaner primitive for this handshake; adopt it when client support is solid. Every executed write, approval, and refusal emits an AuditEvent to the local log.

## 6. Local storage

Per-user app data dir: SQLite (connections metadata, artifact index, dependency graph edges, audit log, deploy requests), snapshot zips on disk, tokens in OS keychain only. Same schema discipline as the main spec (stable UUIDs, `workspace_id` columns) so Phase 0 data survives into the desktop app.

## 7. Milestones

- **P0.1 — Server skeleton (wks 1–2):** stdio server scaffold, keychain + config store, `connect_org` flow end-to-end with the localhost grants page, `list_connections` / `get_permissions`. ✅ **Built and verified 2026-08-06** — all six lifecycle tools exercised from a live Claude session against a real dev org: OAuth loopback, human-only grants page with implication-rule cascade confirmed, grants matrix with not-granted surfaced, before/after audit diffs on grant changes, revoke-and-remove with audit history surviving deletion. Known dev shortcut to replace: currently borrowing the `PlatformCLI` connected-app client id and requesting the extra `web` scope — the Contrail connected app (open item) fixes both.
- **P0.2 — Metadata read (wks 2–5):** baseline retrieve + snapshot + index, `retrieve_metadata` / `describe_schema` / `search_metadata`, reference extractor + `get_dependencies`. *The copy-paste-shuffle killer — first dogfood-able moment.* ✅ **Built and verified 2026-08-06** — all six tools exercised live: async snapshot refresh with progress polling (~70s full org: 352 objects, ~3.3k fields), retrieve returned full Flow XML with dependency summary, search hit both names and content, index and `live=true` listings agree, depth-2 traversal correctly walks reverse edges. **Open findings ledger:** (1) standard/feature-delivered flows (e.g. `get_existing_swarm`, lowercase snake_case, created by Automated Process) are invisible to Metadata API listMetadata — add a Tooling API fallback (`FlowDefinition` / `Flow.Metadata`) before reporting not-found, and union both sources in `list_metadata` with a source marker; (2) `blast_radius` returned `{}` — confirm implemented vs silently failing (P0.4 depends on it); (3) extractor emits object-level edges only (9 edges org-wide) — add field-level refs, permission-set→object/field edges, and flow→subflow/action edges; (4) replace the borrowed `PlatformCLI` client id + drop the `web` scope via the Contrail connected app.
- **P0.3 — Diff + data + diagnostics (wks 4–7):** `diff_orgs` / `diff_artifact`, `soql_query`, `get_debug_logs`, grant classification hardened.
- **P0.4 — Deploys (wks 6–9):** validate/execute with confirmation codes, destructive-change detection, blast radius, audit log complete. Dogfood against dev orgs only.
- **P0.5 — Plugin packaging + pilot (wks 8–10):** skill written and tuned, plugin packaged, 3–5 internal pilots on real (non-prod) engagement work.

Solo-buildable; the P0.2 demo lands inside a month.

## 8. Open items

- Connected app: create the Contrail multi-org connected app (public client, PKCE); naming on the consent screen inherits the product name — same M1 trademark deadline as the main spec.
- Elicitation support tracking (replaces confirmation codes when viable).
- Windows/macOS keychain parity check (Electron `safeStorage` isn't available outside Electron — use `keytar` or platform equivalents for the bare Node server).
- Decide the config-store format for the optional per-project connection list (likely a small JSON checked into the engagement repo).
- Exit criteria to desktop M0: engine API stable, ≥3 pilots using it weekly, workflow list validated (which of browse/diff/deploy actually gets used).
