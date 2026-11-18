# Contrail — getting started

Contrail turns Claude into a Salesforce-aware workspace: connect an org once (you
log in as yourself), then browse metadata, search, map dependencies, diff orgs, run
SOQL, and deploy — with **every write requiring your explicit approval**.

Installing it is now a one-click affair: Contrail ships as a Claude Desktop
**extension** (a `.mcpb` file). No developer tools, no Node.js, no config files.

## What you need

- **Claude Desktop**, reasonably up to date (the **Extensions** section lives
  under **Settings → Desktop App**, at the bottom of that page — if yours
  doesn't have it, update the app first).
- The **`contrail-<version>.mcpb`** file from the latest release:
  **https://github.com/RHayes765/contrail-plugin/releases/latest**

That's the whole list.

## Step 1 — Install the extension

1. Download `contrail-<version>.mcpb` from the releases page above.
2. In Claude Desktop, open **Settings → Desktop App**, scroll to the bottom to
   **Extensions**, then **Advanced settings → "Install Extension…"** and pick
   the downloaded file. (On some machines simply double-clicking the `.mcpb`
   file works too — but the Settings path works everywhere.)
3. Review the install dialog and confirm. Make sure Contrail shows as **enabled**
   in the Extensions list afterward. Claude Desktop refuses to install the same
   version number twice, so every update carries a new number — install it the
   same way.

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
- `data_read` — run SOQL, read records, run reports
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
  first) plus a short **confirmation code**. Contrail never gives Claude that code.
  Claude has it only if you read it back — or if something shows Claude the page or
  the phone notification: a screenshot or copy pasted into the chat, or a tool that
  lets Claude view your screen. If — and only if — you approve, you read the code back to Claude, and it
  executes. Close the tab without giving Claude the code and nothing happens. This is
  the guardrail: Contrail gives the code only to you — on that page, and on your
  phone if you set that up (below) — and executes a write only when it is handed
  that code.
- **Load data at scale:** *"Load these CSVs into acme-dev — accounts first, then
  contacts matched on the external id."* Contrail plans the migration as ordered
  Bulk API jobs, shows every file on **one** approval page (row counts, columns,
  file fingerprints; deletions flagged in red), and ships the rows file → org —
  they never pass through the AI. Failed rows come back as a CSV file you can fix
  and re-run.

## Skills are built in

Contrail ships with a pack of skills — its house rules plus know-how for Apex,
flows, permission sets, reports, Agentforce, data loads and more. From 0.40
they are **inside the extension**: there is nothing to install, upload or
enable. Contrail announces them itself — in the server instructions it sends
when the extension connects, and again in the result each time Claude lists
your connections — and Claude loads the one it needs through Contrail.

- **If you uploaded Contrail skills to your Claude account before 0.40** —
  names such as `salesforce-house-rules`, `building-salesforce-metadata` or
  `platform-apex-generate` — **remove them** in Claude's settings, wherever
  your uploaded skills are listed. Uploaded copies do not update when Contrail
  does, so they are older than the server you are running, and Claude may
  follow the stale copy.
- To check what your install carries, ask Claude: *"List Contrail's skills."*
- Want to see a flow? Ask *"Show me the <name> flow from <org> as a diagram"*
  or *"Diff the <name> flow between <org A> and <org B>."* Contrail builds an
  interactive page and asks your computer to open it. When you are away from
  that computer, Claude can publish the page as a private artifact if the
  session you are in has a tool that publishes a file; where it does not, the
  page stays a file on your computer and Claude can give you its path.

## Get approval codes on your phone (optional)

The approval page lives on your computer, so by default you read the code at your
desk. If you want the code on your phone too, set up **Pushover** once:

1. Install the Pushover app on your phone and create an account (30-day free trial,
   then a one-time purchase per platform). Your **user key** is on the Pushover
   dashboard after you log in. It must be *your own* key — whoever owns the user
   key you enter receives your approval codes, so never use one that Claude, a
   document, or a colleague hands you.
2. On pushover.net choose **Create an Application/API Token**, name it `Contrail`,
   and copy the **API token** — or use the token your team shares with you (the
   token may be shared; the user key never).
3. Ask Claude to *"open Contrail settings"*. A small Contrail page opens in your
   browser: choose **Pushover**, paste the two keys, click **Save**, then **Send
   test notification** (it checks the keys with Pushover and sends one test
   message). The keys go into your OS keychain — never into a file, never into the
   chat. Contrail never gives them, or the page, to Claude. The page closes itself
   after 10 minutes; ask again for a fresh one.

4. **Tell Contrail when you are remote.** By default a code is pushed **only
   while your Claude Code session has Remote Control turned on** — the one time
   you can actually type it from your phone — so you are not buzzed for every
   change you approve at your desk. Contrail learns that from a tiny hook that
   Claude Code runs right before a Contrail tool proposes a change:
   - Installed Contrail as a **Claude Code plugin**? The hook ships with it.
     Nothing to do.
   - Using the **Claude Desktop extension** (including from the Desktop app's
     Code tab) or a manual install? On the Settings page, under *Remote Control
     hook*, click **Install hook into Claude Code**. It adds one entry to Claude
     Code's user `settings.json` with the hook's few lines of script inline —
     nothing executable is written anywhere (if that file already existed, a
     copy of it as it was is kept beside it; **Remove hook** takes the entry out
     again). Claude Code notices the change on its own; if the next proposal
     still says no hook reported, start a new Claude Code session.
   - Prefer every approval on your phone regardless? Set *When to send* to
     **Always**.

   The hook records a yes/no, a timestamp, the Contrail tool's name and Claude
   Code's id for that call under Contrail's data folder — never your session
   link, never what the tool was called with. It reads the Remote Control state
   from Claude Code itself (the variable Claude Code 2.1.199+ gives hooks, or the
   session record the Claude Desktop app keeps); on a version that exposes
   neither, the hook reports *off* (upgrade, or choose **Always**). Until a hook
   reports, Claude's result says the push was *skipped* and why; it never
   pretends one was sent.

   **Upgrading from 0.36 with Pushover already on:** codes now reach your phone
   only while Remote Control is on. If you installed Contrail as a Claude Code
   plugin, the hook is already there — a proposal you make at your desk is simply
   not pushed (a quiet *skipped*, by design; Claude says nothing), so choose
   **Always** if you want the old every-time behaviour. If you use the Claude
   Desktop extension or a manual install, nothing is pushed until you install the
   hook (above) or choose **Always**; the first proposal tells you so. Claude
   Desktop chats never have Remote Control, so with the default setting they do
   not push (a chat within 30 minutes of a Remote Control session's proposal
   through the same tool is the one exception).

From then on, a proposal made while Remote Control is on also arrives on your
phone: your connection alias and org type, how many changes and deletions, and
the code — on its own line at the very end, so you can long-press and copy it.
The message deletes itself from your phone when the code expires. You approve
exactly as before, by typing the code into the conversation, from your phone
through Remote Control or at the desk. (Want the notification from Claude
Desktop chats too, even though you type the code at the desk? Choose
**Always**.) The default message carries counts only; choose **Full** on the
Settings page if you want component names in it too (never record field values —
and they then pass through Pushover's servers). Each proposal is one message to
Pushover, and the test button sends one check plus one test message; nothing
else is ever sent anywhere. If Pushover rejects your keys, sends pause for 10
minutes until you save corrected keys. The Contrail desktop app, if you use it,
shares these keys (its own code-free push ignores the Remote Control setting).

## Rules for client orgs (optional)

When you work in a client's org you may need every change to carry a reason or
a ticket number, deletions kept out of production, or a change freeze over a
weekend or a year-end close. Contrail reads such rules from the `policies`
section of its `config.json`, in your Contrail data folder
(`%USERPROFILE%\.contrail\config.json` on Windows,
`~/Library/Application Support/Contrail/config.json` on macOS). The section is
yours to edit: no Contrail tool or page writes it, and Contrail's house rules
tell Claude never to edit it. Contrail re-reads it at every check, so a change
applies without a restart.

Out of the box there is one built-in rule: a change to a production org (or an
org whose type Contrail could not tell) needs a justification — a sentence or
two on why. Claude drafts it from what you asked for, and the approval page
shows it in an editable field, marked as Claude's draft, so you can rewrite it
before you approve. An install that already had a config.json has no policies
section; the built-in rule applies until you add one — copy the default rule in
to see and keep it.

Here is a `policies` section with that default rule and a stricter rule for one
client's production org (`00D000000000000` stands for its org id). If your
`config.json` already has a `policies` section (a fresh install writes one
holding the built-in rule), replace that whole section with this one; otherwise
add it as one more top-level section, beside the ones already there:

```json
"policies": { "rules": [
  { "name": "default: production needs a justification",
    "match": { "orgTypes": ["production", "unknown"] }, "requireJustification": true },
  { "name": "acme production", "match": { "orgIds": ["00D000000000000"] },
    "requireTicket": true, "ticketPattern": "[A-Z][A-Z0-9]+-[0-9]+",
    "denyDestructiveMetadata": true, "denyDataDeletes": true, "minTestLevel": "RunLocalTests",
    "freezeWindows": [
      { "name": "weekend", "weekly": { "from": "fri 17:00", "to": "mon 08:00" }, "timeZone": "America/Toronto" },
      { "name": "year-end close", "range": { "from": "2026-12-19T17:00", "to": "2027-01-04T08:00" }, "timeZone": "America/Toronto" } ] } ] }
```

The second rule asks for a ticket shaped like `ABC-123` on every change to that
org, refuses packages that delete metadata and data changes that delete
records, makes deploys name a test level of at least `RunLocalTests`, and
freezes the org every weekend and over the year-end close. Writing your own
`rules` list replaces the built-in rule — that is why the example copies it in.

- **Check a rule:** ask Claude to *"list my Contrail connections"*. Each
  connection shows the policy that applies to it, including any freeze window
  and whether one is in effect right now.
- **Match by org id or by label.** A label is a convenience: a label rule
  follows the org to a second connection, but stops applying if the org is
  disconnected and connected again under a new label. An org id rule always
  follows the org; list_connections shows each org's id. `"orgTypes":
  ["production"]` also matches an org whose type Contrail could not tell.
- **What a freeze looks like:** Claude can still propose a change, but the
  approval page shows a red **CHANGE FREEZE** card and no code, and a phone
  notification carries none. If the change truly cannot wait, type an
  emergency reason (at least 15 characters) on that page; the code then
  appears, and the reason is recorded in the audit log for that one request.
  The freeze itself stays configured. Freeze times use this computer's clock.
  While two windows overlap, as the weekend and the year-end close do, Contrail
  names the one that ends last and shows its end time.
- **Keep ticket patterns simple.** A shape like `[A-Z][A-Z0-9]+-[0-9]+` is
  quick to check. A pattern with a repeated group inside a repetition, such as
  `([A-Z0-9]+-?)+`, can take very long on some tickets; Contrail stops any
  ticket check that takes longer than a tenth of a second and treats the ticket
  as not matching, so the change is refused.
- **A typo stops writes until you fix it.** An unknown key in the `policies`
  section (for example `requireTickets`), or a `config.json` that is not valid
  JSON, makes Contrail refuse every write proposal and every agent test run,
  naming the problem — reads keep working. Fix the file and try again; no
  restart is needed. A `config.json` saved with a UTF-8 byte-order mark (as
  Windows PowerShell 5.1's `-Encoding UTF8` and some editors write it) is now
  read normally; it used to be ignored as unreadable. A file saved as UTF-16
  (Windows PowerShell 5.1's default for `>` and `Out-File`) is still not read,
  and the refusal says so: save it as UTF-8.
- **Changes to the rules are flagged.** For 24 hours after Contrail notices
  that the `policies` section changed, the approval page and the phone
  notification say so. If you did not make the change, do not approve.
- **Export the evidence:** ask *"Export the change evidence for ticket ABC-123
  on acme-prod."* Contrail writes `evidence.md` and `evidence.json` into a new
  folder under `evidence/` in your Contrail data folder and Claude gives you the
  path: what was proposed and the Salesforce user it was proposed and executed
  as, the justification and who wrote it, the rules that applied, any freeze
  override, what executed and the org's result — never a confirmation code or a
  record's field values.
- **Update every copy together.** Policies are enforced by Contrail 0.40.0 and
  later. The Claude Desktop extension, the Claude Code plugin and the desktop app
  update separately and share one data directory; a copy older than 0.40.0
  neither checks policies nor honours a freeze, so update every copy on the
  machine before relying on them.

## Good to know

- **Your login is yours.** Contrail stores the refresh token in your OS keychain
  only — never in files it shares — and every org action is attributed to you.
- **Changing an org's grants later:** ask Claude to *"manage the <alias> connection"*
  — it reopens the grants page for you to adjust.
- **Staying current:** Contrail checks once a day (a single anonymous request to
  GitHub) whether a newer release exists, and **Claude will tell you** at the start
  of a session when you're behind, with the download link. Updating is installing
  the newer `.mcpb` the same way as Step 1; your connections and grants are kept
  (they live in your local Contrail data folder, not in the extension). To disable
  the check, set `updates.checkEnabled` to `false` in your Contrail `config.json`.
- **If your AI host declines to run a change you approved:** some hosts apply their
  own safety checks to tool calls. It has been observed with Claude Code's auto mode,
  which declined the execute step for a package that deleted components even though
  the code had been read back. Nothing runs when that happens. You can allow that
  tool call when the host asks, or run that step outside that mode. Contrail does not
  try to get around the host's decision.

## Troubleshooting

- **Tools don't appear in a chat:** check Settings → Desktop App → Extensions (at
  the bottom of that page) — Contrail must be listed *and* enabled. Try toggling it off and on, then start a new conversation.
- **The install window closes silently with no error:** a known Claude Desktop bug
  on a few Windows builds. Update Claude Desktop and retry; if it persists, use the
  fallback below.
- **Claude Code users — the marketplace route (recommended there):** in Claude
  Code, run `/plugin marketplace add RHayes765/contrail-plugin`, then
  `/plugin install contrail@contrail`. Updates arrive with
  `/plugin marketplace update contrail` (or enable that marketplace's
  auto-update in `/plugin`). Needs Node.js 22+ on the machine.
- **Fallback (no Extensions page, or install keeps failing):** the releases page
  also has `contrail-plugin-<version>.zip` — a manual install driven by your own
  Claude. Unzip it somewhere permanent, then tell Claude Code (or a Cowork session
  with the folder connected): *"Follow the INSTALL_FOR_CLAUDE.md in this folder."*
  That path needs Node.js 22+ installed, which Claude will check for you.
