# Contrail — getting started

Contrail turns Claude into a Salesforce-aware workspace: connect an org once (you
log in as yourself), then browse metadata, search, map dependencies, diff orgs, run
SOQL, and deploy — with **every write requiring your explicit approval**. This guide
gets it installed and running. The install itself is done *by Claude* for you; your
job is mostly downloading, unzipping, and approving.

## What you need first

- **Claude Desktop** (where you'll use Contrail day to day).
- **A Claude that can run commands and edit files** to do the install — either
  Claude Code, or a Claude Desktop **Cowork** session with a folder connected. (A
  plain chat can't install it; it needs terminal + file access.)
- **Node.js 20 or newer** — check by running `node --version`; if missing, install
  from https://nodejs.org (the "LTS" build).

## Step 1 — Download and unzip

1. Download `contrail-plugin.zip` from the Google Drive link.
2. Unzip it to a **permanent** location you won't move or delete — e.g.
   `Documents/Contrail`. **Not** your Downloads folder or a temp dir: the plugin
   runs from wherever you put it, every time Claude Desktop starts, so if it moves
   the plugin breaks.

## Step 2 — Let Claude install it

1. Open your install-capable Claude (Claude Code, or Cowork with the unzipped
   `Contrail` folder connected).
2. Tell it: **"Follow the INSTALL_FOR_CLAUDE.md in this folder to install the
   Contrail plugin."** (That file is in the folder you just unzipped.)
3. Claude will build the engine and register it in your Claude Desktop config. It
   will ask you to do one manual thing: **fully quit and reopen Claude Desktop**
   (quit from the system tray / menu bar — closing the window isn't enough). MCP
   plugins only load at startup.

## Step 3 — Confirm it's working

In a new Claude Desktop conversation, ask: **"List my Contrail connections."** If it
comes back with an empty list (rather than "tool not found"), you're installed.

## Step 4 — Connect an org

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

## Step 5 — Using it

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

- **Keep the unzipped folder where it is.** Moving/deleting it breaks the plugin
  (re-run the install if you must relocate it).
- **Your login is yours.** Contrail stores the refresh token in your OS keychain
  only — never in files it shares — and every org action is attributed to you.
- **Changing an org's grants later:** ask Claude to *"manage the <alias> connection"*
  — it reopens the grants page for you to adjust.
- **Trouble?** If the Contrail tools don't appear, make sure you fully quit and
  reopened Claude Desktop after install. If they still don't, hand your install
  Claude the `INSTALL_FOR_CLAUDE.md` again and ask it to verify the registration.
