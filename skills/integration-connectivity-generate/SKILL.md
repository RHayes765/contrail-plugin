---
name: integration-connectivity-generate
description: "Use this skill when users need to set up or modify Salesforce outbound-integration plumbing through Contrail: Named Credentials, External Credentials, Auth Providers, callout authentication, endpoint changes, or credential migrations. Trigger when the user mentions named credentials, external credentials, callout: endpoints, API keys for callouts, OAuth for outbound integrations, per-user vs named principals — or when a validate_deploy of NamedCredential/ExternalCredential/AuthProvider metadata fails, or callouts fail with Insufficient privileges. DO NOT TRIGGER for: Connected App / inbound OAuth app configuration (Setup UI territory), the Apex callout code itself (platform-apex-generate), Platform Event / CDC channel metadata (building-salesforce-metadata), or data loads (salesforce-data-migration)."
metadata:
  domains: ["Integration"]
  minApiVersion: "61.0"
  upstream:
    repo: "forcedotcom/sf-skills"
    commit: "49064f7"
    version: "1.1"
    adapted: "2026-09-24"
  relatedSkills:
    - "salesforce-house-rules"
    - "building-salesforce-metadata"
    - "platform-permission-set-generate"
    - "platform-apex-generate"
---

# Integration Connectivity (Named & External Credentials)

Authoring the credential stack that authenticated outbound callouts ride on —
External Credentials, Named Credentials, Auth Providers, and the permission
pairing that makes them usable — for deployment through the Contrail engine.

## The three-layer model (and where secrets live)

```
ExternalCredential   — the AUTH: protocol (OAuth/JWT/Basic/Custom/AwsSv4) +
                       principals (who authenticates: named or per-user)
        ▲
NamedCredential      — the ENDPOINT: a URL, referencing the external
                       credential; Apex/Flow call it as callout:Name
        ▲
PermissionSet        — the ACCESS: externalCredentialPrincipalAccesses,
                       one grant per principal, dash-named Cred-Principal
```

**The secret boundary — the fact everything else follows from:** credential
*metadata* never carries working secrets. The values behind a principal (API
key, client secret, password) are entered by a **human in Setup → Named
Credentials → External Credentials → the principal** *after* the deploy, and
they never appear in retrieves. So a credential deploy is never "done" on its
own: it is deploy → human enters principal values → permission set grants the
principals → callouts work. Say all three steps in every summary.

Two legacy exceptions accept literal secrets in metadata — old-style
`NamedCredential` auth fields (`<password>`, AWS keys, OAuth tokens) and
`AuthProvider` `<consumerSecret>`. Never author one: the value would sit in
the local snapshot, the audit trail, and the approval page (Contrail flags
this), and a retrieve returns only a placeholder so the value never
round-trips. New work uses External Credentials, where the platform gives
secrets no metadata path at all.

## How the family deploys through Contrail

```jsonc
{ "type": "ExternalCredential", "api_name": "Billing_Auth", "content": "<?xml …?><ExternalCredential>…" }
{ "type": "NamedCredential",   "api_name": "Billing_API",  "content": "<?xml …?><NamedCredential>…" }
{ "type": "AuthProvider",      "api_name": "Acme_SSO",     "content": "<?xml …?><AuthProvider>…" }
```

- **`content` is metadata format** — full documents. The packager owns
  `package.xml` and file placement; never author manifests or file trees.
- All three types are **explicit-refresh-only** in snapshots:
  `refresh_snapshot types:["NamedCredential","ExternalCredential","AuthProvider"]`
  before reading or diffing them locally.
- **Modifies are whole-document replaces** (the approval page warns): retrieve
  first, edit the complete document. On an ExternalCredential this bites
  hardest — a principal parameter you omit is **deleted org-side together with
  the secret a human entered for it**.
- Ship the External Credential **with (or before)** the Named Credential that
  references it, and the permission set in the same package — Contrail's
  coverage checker flags un-granted principals on the approval page.

**Environments, once:** in Claude Desktop chat (no file tools) author metadata
INLINE as `content`. In Claude Code, author files into Contrail's `staging/`
directory from the start (`list_connections` returns the exact path as
`staging_dir`) and pass `content_file` — the working folder is not a deploy
source root.

## Ground before you author

House rules first: `list_connections`, `get_permissions` — see
salesforce-house-rules. Then:

| Check | Tool |
|---|---|
| What credentials already exist | `refresh_snapshot types:["NamedCredential","ExternalCredential","AuthProvider"]`, then `list_metadata` |
| Grammar oracle — how THIS org shapes them | `retrieve_metadata` an existing ExternalCredential/NamedCredential |
| Who already grants a principal | `search_metadata "externalCredentialPrincipalAccesses"` (or the credential name) |
| What consumes a credential | `get_dependencies` on the NamedCredential (Apex `callout:` references and the NC→EC→AuthProvider chain are indexed edges) |

If a needed grant is missing, record `<check>=unavailable: <grant> not granted`,
offer `manage_connection`, and say so in the deploy summary.

## Choose the auth model

**External-credentials-first**: every new integration gets an
ExternalCredential + SecuredEndpoint NamedCredential pair (GA since
Winter '23). Legacy single-principal NamedCredentials (auth configured
directly on the NC) are deprecated-in-place — touch them only to migrate them.

| Scenario | Principal type |
|---|---|
| Service/background/batch integration | `NamedPrincipal` (one shared identity) |
| User-specific data access at the remote end | `PerUserPrincipal` (each user authenticates) |
| User-initiated with per-user audit trail | `PerUserPrincipal` |

Per-user OAuth browser flows also need an **AuthProvider** (and users
authenticate themselves once, from Setup or a prompted flow). Named principals
usually don't.

## Authoring grammar (live-confirmed — trust the retrieve, not upstream assets)

An ExternalCredential's principals are `externalCredentialParameters` blocks
with `parameterType` `NamedPrincipal` or `PerUserPrincipal`, named by
`parameterName`. (Upstream sf-skills assets model principals as a
`<principals>` element — real orgs do not retrieve that shape; when in doubt,
retrieve an existing credential and copy its grammar.)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExternalCredential xmlns="http://soap.sforce.com/2006/04/metadata">
    <authenticationProtocol>Custom</authenticationProtocol>
    <externalCredentialParameters>
        <parameterGroup>DefaultGroup</parameterGroup>
        <parameterName>Custom</parameterName>
        <parameterType>AuthProtocolVariant</parameterType>
        <parameterValue>NoAuthentication</parameterValue>
    </externalCredentialParameters>
    <externalCredentialParameters>
        <parameterGroup>Billing_Service</parameterGroup>
        <parameterName>Billing_Service</parameterName>
        <parameterType>NamedPrincipal</parameterType>
        <sequenceNumber>1</sequenceNumber>
    </externalCredentialParameters>
    <label>Billing Auth</label>
</ExternalCredential>
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
    <allowMergeFieldsInBody>false</allowMergeFieldsInBody>
    <allowMergeFieldsInHeader>true</allowMergeFieldsInHeader>
    <calloutStatus>Enabled</calloutStatus>
    <generateAuthorizationHeader>true</generateAuthorizationHeader>
    <label>Billing API</label>
    <namedCredentialParameters>
        <parameterName>Url</parameterName>
        <parameterType>Url</parameterType>
        <parameterValue>https://api.example.com</parameterValue>
    </namedCredentialParameters>
    <namedCredentialParameters>
        <externalCredential>Billing_Auth</externalCredential>
        <parameterName>ExternalCredential</parameterName>
        <parameterType>Authentication</parameterType>
    </namedCredentialParameters>
    <namedCredentialType>SecuredEndpoint</namedCredentialType>
</NamedCredential>
```

Auth-protocol parameters (OAuth client id, scope, token endpoint, JWT claims)
are more `externalCredentialParameters` entries; their exact `parameterType`
values vary by protocol — retrieve a working credential of the same protocol
as the oracle rather than guessing enum values. Client secrets get **no**
`parameterValue`: they are principal values, entered in Setup.

## The permission pairing

```xml
<externalCredentialPrincipalAccesses>
    <enabled>true</enabled>
    <externalCredentialPrincipal>Billing_Auth-Billing_Service</externalCredentialPrincipal>
</externalCredentialPrincipalAccesses>
```

Dash-joined `<ExternalCredentialDevName>-<principalName>`, one block per
principal. Without it, callouts fail with `Insufficient privileges` no matter
what Setup holds. Authoring the permission set is
`platform-permission-set-generate`'s territory; Contrail's coverage checker
counts these grants, so an uncovered principal shows up on the approval page
by name.

## Workflow

1. **Ground** (table above) and pick the auth model.
2. **Author** ExternalCredential → NamedCredential → permission set as one
   package (retrieve-first for any modify).
3. **Deploy and verify** — the salesforce-house-rules §3 ritual, then
   `refresh_snapshot types:["NamedCredential","ExternalCredential","AuthProvider"]`.
4. **Hand the human their steps, explicitly**: enter each principal's values
   in Setup (name the principals), assign the permission set, and for per-user
   principals have users authenticate once. Contrail cannot do these.
5. **Smoke the callout** from Apex (`platform-apex-generate` doctrine:
   endpoint `'callout:Billing_API/path'`, never a hardcoded URL or header
   secret) — unit-test logic with `Test.setMock`; a REAL callout probe needs
   the anonymous-Apex ritual and commits, so say so.

**Migrating a legacy NamedCredential**: create the ExternalCredential (same
protocol) + a new SecuredEndpoint NamedCredential + the permission-set grants;
humans re-enter secrets in Setup; repoint Apex/Flows at the new `callout:`
name; verify; only then delete the legacy credential (destructive change,
flagged prominently — the human decides).

## High-signal rules

- Never hardcode credentials — no secret ever appears in Apex, metadata
  content, chat, or a staged file.
- No synchronous callouts from triggers — trigger-originated callouts go
  async (`Queueable` + `Database.AllowsCallouts`).
- Set explicit timeouts; retry only 5xx/timeouts, max 3, with idempotency
  keys on retried POSTs.
- Minimize OAuth scopes (`read:orders`, not `admin:*`).
- One credential per environment tier (`Billing_API` in each org, pointing at
  that tier's endpoint) — never a sandbox credential aimed at production.
- A deployed credential that "works on my user" but fails for others is
  almost always a missing `externalCredentialPrincipalAccesses` grant.

---
*Adapted for Contrail from [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) @ 49064f7 (Apache-2.0, © Salesforce, Inc.). Modified: retargeted from sf CLI / DX MCP tooling to the Contrail engine tools; scoring rubric and shell automation dropped; credential grammar corrected to live-retrieved shapes; workflow restructured for Contrail's human-approval write contract and secret boundary.*
