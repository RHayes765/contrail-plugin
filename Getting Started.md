# Contrail — getting started

Contrail turns Claude into a Salesforce-aware workspace: connect an org once (you
log in as yourself), then browse metadata, search, map dependencies, diff orgs, run
SOQL, and deploy — with **every write requiring your explicit approval**.

Installing it is now a one-click affair: Contrail ships as a Claude Desktop
**extension** (a `.mcpb` file). No developer tools, no Node.js, no config files.

## What you need

- **Claude Desktop**, reasonably up to date (Settings must have an **Extensions**
  page — if yours doesn't, update the app first).
- The **`contrail-<version>.mcpb`** file from the Google Drive folder.

That's the whole list.

## Step 1 — Install the extension

1. Download `contrail-<version>.mcpb` from Google Drive.
2. In Claude Desktop, open **Settings → Extensions → Advanced settings →
   "Install Extension…"** and pick the downloaded file.
   (On some machines simply double-clicking the `.mcpb` file works too — but the
   Settings path works everywhere.)
3. Review the install dialog and confirm. Make sure Contrail shows as **enabled**
   in the Extensions list afterward.

You can delete the downloaded file when done — the extension is self-contained and
managed by Claude Desktop from here on.

## Step 2 — Confirm it's working

Start a **new** conversation and ask: **"List my Contrail connections."** If it
comes back with an empty list (rather than "tool not found"), you're installed.

## Step 3 — Connect an org

Just ask Claude in plain language:

- *"Connect my dev org."* → opens a browser login against **login.salesforce.com**.
- *"Connect the sandbox at acme--uat.sandbox.my.salesforce.com."* → names the exact
  login host (best for sandboxes). Or *"connect a sandbox"* → uses
  **test.salesforce.com**.

You log in **as yourself** in the browser. Then a small **Contrail page** opens where
*you* set the org's five permission grants with checkboxes:

- `metadata_read` — read flows, Apex, objects/fields; search; dependencies; diff
- `metadata_write` — validate and deploy metadata (every deploy still needs your approval)
- `diagnostics_read` — debug logs, flow errors
- `data_read` — run SOQL, read records
- `data_write` — insert/update/delete records (every change still needs your approval)

Tick what you want this connection to allow, and save. **Claude never sets these —
only you, on that page.** (Heads-up: the Salesforce consent screen currently shows
the app as *"Salesforce CLI"* — that's expected in this build; log in normally.)

Each teammate connects their **own** orgs; nothing is shared, and grants are
per-connection.

## Step 4 — Using it

Ask in plain language. A few things it's good at:

- **Explore:** *"Refresh the snapshot of acme-uat, then search for anything using the
  Case_Summary field and show me what would break if I changed it."*
- **Compare orgs:** *"Diff the Account object between acme-uat and acme-prod."*
  (needs `metadata_read` on both, and a snapshot of each.)
- **Read data:** *"How many open cases are there?"* / *"Show me this record: <id>."*
- **Diagnose:** *"Pull the latest debug logs from acme-uat."*
- **Deploy / change data (the safe part):** when you ask Claude to deploy metadata or
  change records, it first **validates** and opens an **approval page in your
  browser** showing exactly what will change (deletions and data-loss risks flagged
  first) plus a short **confirmation code**. Claude cannot see that code. If — and
  only if — you approve, you read the code back to Claude, and it executes. Close the
  tab and nothing happens. This is the guardrail: no write occurs without you reading
  a code off that page.

## Good to know

- **Your login is yours.** Contrail stores the refresh token in your OS keychain
  only — never in files it shares — and every org action is attributed to you.
- **Changing an org's grants later:** ask Claude to *"manage the <alias> connection"*
  — it reopens the grants page for you to adjust.
- **Updating Contrail:** install the newer `.mcpb` the same way; your connections
  and grants are kept (they live in your local Contrail data folder, not in the
  extension).

## Troubleshooting

- **Tools don't appear in a chat:** check Settings → Extensions — Contrail must be
  listed *and* enabled. Try toggling it off and on, then start a new conversation.
- **The install window closes silently with no error:** a known Claude Desktop bug
  on a few Windows builds. Update Claude Desktop and retry; if it persists, use the
  fallback below.
- **Fallback (no Extensions page, or install keeps failing):** the Drive folder also
  has `contrail-plugin.zip` — a manual install driven by your own Claude. Unzip it
  somewhere permanent, then tell Claude Code (or a Cowork session with the folder
  connected): *"Follow the INSTALL_FOR_CLAUDE.md in this folder."* That path needs
  Node.js 22+ installed, which Claude will check for you.
