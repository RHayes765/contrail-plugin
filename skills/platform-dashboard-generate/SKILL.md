---
name: platform-dashboard-generate
description: "Use this skill when users need to create, modify, or validate Salesforce Dashboard metadata through the Contrail engine. Trigger when users mention dashboards, dashboard components (charts, gauges, metrics, tables), dynamic dashboards, the dashboard running user, dashboard filters, Lightning grid layout, dashboard folders or folder sharing, or when a .dashboard deploy fails. DO NOT TRIGGER for authoring the underlying reports (that is platform-report-generate), for custom report types (platform-custom-report-type-generate), or for CRM Analytics / Wave dashboards — an entirely different metadata family this skill does not cover."
metadata:
  domains: ["Platform"]
  relatedSkills:
    - salesforce-house-rules
    - building-salesforce-metadata
    - platform-report-generate
---

# Dashboards through Contrail

Use this skill to:

- Create Dashboard metadata — classic three-column or Lightning grid layout
- Ship a new dashboard folder (with sharing) in the same package
- Wire dashboard filters, gauges, metrics, and tables to their source reports
- Troubleshoot `.dashboard` deploy failures — above all the running-user one

Follow **salesforce-house-rules** for connections, grants, and the write ritual;
**building-salesforce-metadata** for packaging. Every element and enum value
here comes from the Metadata API grammar for Dashboard, Folder, and FolderShare;
where the platform documentation contradicts itself, the discrepancy is called
out — retrieve a live example instead of guessing.

## 1. How a dashboard deploys through Contrail

A Dashboard is a **top-level, folder-addressed** component. `api_name` is the
folder-qualified name; `content` is the full document — XML declaration and
`<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata">` root (metadata
format, `.dashboard` extension; Contrail generates the manifest and meta files):

```jsonc
{
  "connection": "uat",
  "components": [
    { "type": "Dashboard", "api_name": "Exec/Sales_Overview",
      "content_file": "<staging>/Sales_Overview.dashboard.xml" }
  ]
}
```

- **Folder-first packaging.** The folder half of `api_name` must already exist
  in the target org or ship as its own component **in the same package**:

  ```jsonc
  { "type": "DashboardFolder", "api_name": "Exec",
    "content": "<DashboardFolder xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n    <name>Exec</name>\n    <folderShares>\n        <accessLevel>View</accessLevel>\n        <sharedTo>Sales_Leadership</sharedTo>\n        <sharedToType>Group</sharedToType>\n    </folderShares>\n</DashboardFolder>" }
  ```

- **The referenced reports must exist** — deployed already, or as components in
  the same package. See §8 for what happens when they don't.
- **Environments, once:** in Claude Desktop chat (no file tools) author inline
  and pass `content`. In Claude Code, write the document under Contrail's
  `staging/` directory and pass `content_file` — dashboards are big; prefer the
  file route.

## 2. Ground before you author

House rules first (`list_connections`, `get_permissions`). Then:

| Need | Tool |
|---|---|
| An existing dashboard as template | `search_metadata` / `list_metadata` type `Dashboard`, then `retrieve_metadata` — retrieved XML is the ground truth for element names and ordering in this org |
| Folder-qualified source-report names | `list_metadata` type `Report` (names come back `Folder/DevName`) |
| Those reports actually run | `soql_query` on the `Report` sobject; `get_report_data` on each (needs `data_read`) |
| The target folder exists | `list_metadata` type `Dashboard` (folder prefixes) or `retrieve_metadata` the folder |
| The running user exists in the TARGET org (§4) | `soql_query`: `SELECT Id, Username, IsActive FROM User WHERE Username = '...'` |

## 3. Anatomy: classic columns vs Lightning grid

Both layouts share the same required cosmetic skeleton (every element below
appears in the API's own samples and is marked required in the field grammar):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata">
    <backgroundEndColor>#FFFFFF</backgroundEndColor>
    <backgroundFadeDirection>Diagonal</backgroundFadeDirection>
    <backgroundStartColor>#FFFFFF</backgroundStartColor>
    <!-- layout goes here: sections OR grid -->
    <runningUser>user@example.org</runningUser>
    <textColor>#000000</textColor>
    <title>Sales Overview</title>
    <titleColor>#000000</titleColor>
    <titleSize>12</titleSize>
</Dashboard>
```

`backgroundFadeDirection`: `Diagonal` | `LeftToRight` | `TopToBottom`. Same
start/end color = no gradient. Optional org-wide chart defaults: `chartTheme`
(`light`/`dark`) and `colorPalette` (`Default`, `accessible`, `bluegrass`,
`colorSafe`, `dusk`, `earth`, `fire`, `gray`, `heat`, `justice`, `nightfall`,
`pond`, `sunrise`, `tropic`, `unity`, `water`, `watermelon`) — API 42.0+;
`dashboardChartTheme` / `dashboardColorPalette` are the pre-42 spellings.
`description` (max 255) is optional; always write one.

**Classic layout** — exactly three columns, `<leftSection>`,
`<middleSection>`, `<rightSection>`, each a section of:

```xml
<leftSection>
    <columnSize>Medium</columnSize>   <!-- Narrow | Medium | Wide -->
    <components>…</components>        <!-- repeat per component, top to bottom -->
</leftSection>
```

**Lightning grid layout** — set `<isGridLayout>true</isGridLayout>` and
replace the three sections with a grid block: `numberOfColumns` (the API
sample uses 9) and `rowHeight` in pixels (sample: 90), plus one
`dashboardGridComponents` entry per component:

```xml
<dashboardGridComponents>
    <colSpan>3</colSpan>          <!-- width in columns -->
    <columnIndex>0</columnIndex>  <!-- left-most column occupied (0-based) -->
    <dashboardComponent>…</dashboardComponent>
    <rowIndex>0</rowIndex>        <!-- top-most row occupied -->
    <rowSpan>3</rowSpan>          <!-- height in rows -->
</dashboardGridComponents>
```

> **Grid element name discrepancy.** The field grammar and WSDL call the
> container `dashboardGridLayout`, but the API doc's own grid sample writes it
> as `<gridLayout>`. Do not guess: `retrieve_metadata` an existing Lightning
> dashboard from the target org and match whatever element name comes back.
> Note the child is `columnIndex`, not `colIndex`.

## 4. The running-user doctrine

`<dashboardType>` sets whose data every viewer sees:

| Value | Meaning | Portability |
|---|---|---|
| `SpecifiedUser` | Every viewer sees data as the one user in `<runningUser>`, regardless of their own access | **Worst.** The username must be valid in each target org |
| `LoggedInUser` | Each viewer sees their own data (a "dynamic dashboard") | **Best** — no username baked in. Org editions cap how many dynamic dashboards you can have; check the target edition's limit before proposing many |
| `MyTeamUser` | Managers can view as their subordinates in the role hierarchy (API 20.0+) | Same username caveat as SpecifiedUser |

**The deploy gotcha that matters:** with `SpecifiedUser`, a `<runningUser>`
username that does not exist in the **target** org fails the deploy — the
classic sandbox-to-production killer, because sandbox usernames carry a
`.sandboxname` suffix that production usernames don't. Before proposing a
`SpecifiedUser` dashboard, verify the username in the target (§2 query), or
recommend `LoggedInUser` for cross-org portability where the security model
allows it.

Two nuances, stated honestly:

- The API documentation claims an absent/invalid `runningUser` is silently
  replaced with the deploying user's username; real deploys are widely
  observed to reject invalid running users instead. The rule is "verify the
  user exists in the target"; any substitution is behavior to confirm live,
  never to rely on.
- **Data exposure is the design, not a bug:** under `SpecifiedUser` every
  viewer sees the running user's data. Pair a broad-visibility running user
  with a tightly shared folder (§7).

## 5. Components

Each component lives in `<components>` (classic) or `<dashboardComponent>`
(grid). The two load-bearing elements:

- `<report>` — **folder-qualified** source report:
  `<report>FolderDevName/ReportDevName</report>` (unfiled private-adjacent
  reports appear as `unfiled$public/DevName`).
- `<componentType>` — required. The common dozen:

| componentType | Renders |
|---|---|
| `Bar` / `BarGrouped` / `BarStacked` / `BarStacked100` | Horizontal bars |
| `Column` / `ColumnGrouped` / `ColumnStacked` / `ColumnStacked100` | Vertical bars |
| `Line` / `LineGrouped` | Lines (`LineCumulative` variants exist) |
| `Pie` / `Donut` / `Funnel` | Proportional charts |
| `Gauge` | Speedometer against a goal |
| `Metric` | Single number (`metricLabel` names it) |
| `Table` / `FlexTable` | Classic table / Lightning table |

The full enum has ~31 values (also `ColumnLine*` combos, `Scatter`,
`ScatterGrouped`, `Image`, `RichText`, `VisualforcePage`,
`LightningWebComponent`, s-control and pulse-metric variants — the doc spells
those last two both `Scontrol`/`SControl` and `PulseMetric`/`PulseMetricCard`
in different places; verify against a retrieved example before using them).

**Chart plumbing:** `useReportChart` (`true` = reuse the source report's chart
settings wholesale) or define the chart here: `autoselectColumnsFromReport`,
`chartSummary` (`column`, optional `aggregate`, `axisBinding` — required when
auto-select is off), `groupingColumn`, `sortBy` (`RowLabelAscending`,
`RowLabelDescending`, `RowValueAscending`, `RowValueDescending`),
`maxValuesDisplayed` (top-N cap), `displayUnits` (`Auto`, `Integer`,
`Hundreds`, `Thousands`, `Millions`, `Billions`, `Trillions`),
`legendPosition` (`Bottom`, `OnChart`, `Right`), `chartAxisRange`
(`Auto`/`Manual` + min/max), and booleans `enableHover`, `expandOthers`,
`showPercentage`, `showTotal`, `showValues`.

**Gauge / metric specifics:** `gaugeMin` / `gaugeMax` bound the dial;
`indicatorBreakpoint1` / `indicatorBreakpoint2` split the range colored by
`indicatorLowColor` / `indicatorMiddleColor` / `indicatorHighColor` (hex).

**Classic tables:** one `<dashboardTableColumn>` per column — `column`
(report column code), optional `aggregateType` (`Sum`, `Average`, `Maximum`,
`Minimum`, `Unique`, `Median`, `Noop`, `None`), `showTotal`, `sortBy` (one
sorted column per table). **Lightning tables** (`FlexTable`) use
`flexComponentProperties` instead — `flexTableColumn` entries (`reportColumn`,
`type` of `Details`/`Aggregates`/`Grouping`, conditional-highlight
breakpoints/colors), `flexTableSortInfo`, `hideChatterPhotos`,
`decimalPrecision`.

**Dynamic values** (API 36.0+): `<dashboardDynamicValues>` with `fieldName`
and `isDynamicUser` — `true` resolves the value as the user running the
dashboard.

## 6. Filters

Dashboard-level filters declare the choices; each report-based component then
maps every filter to one of its own columns.

```xml
<dashboardFilters>
    <dashboardFilterOptions>
        <operator>equals</operator>
        <values>Media</values>
    </dashboardFilterOptions>
    <dashboardFilterOptions>
        <operator>between</operator>
        <values>ABC</values>
        <values>XYZ</values>
    </dashboardFilterOptions>
    <name>Industry</name>
</dashboardFilters>
```

`operator` is one of: `equals`, `notEqual`, `lessThan`, `greaterThan`,
`lessOrEqual`, `greaterOrEqual`, `contains`, `notContain`, `startsWith`,
`includes`, `excludes`, `between`. Only `between` takes two operands
(two `<values>`; minimum inclusive, maximum exclusive) — everything else takes
exactly one.

On the component side, each report-based component carries one
`<dashboardFilterColumns><column>…</column></dashboardFilterColumns>` per
dashboard filter, in the order the filters are declared. The column value is
the report's internal column code (`INDUSTRY`, `ACCOUNT.TYPE`) — copy it from
the retrieved source report, don't invent it.

## 7. Folders and sharing — the only access mechanism

Dashboards have **no FLS and no permission-set grant**. Who can see a deployed
dashboard is decided entirely by its folder's sharing. This is why
`validate_deploy`'s `permission_warning` stays silent for Dashboard packages
**by design** — do not "fix" the silence by inventing a PermissionSet; the
approval page carries a folder-sharing warning instead, and your deploy
summary should state the folder sharing explicitly.

`DashboardFolder` grammar (`api_name` = folder developer name — letters,
numbers, underscores; starts with a letter; no spaces, no trailing or
consecutive underscores):

| Element | Values |
|---|---|
| `name` | Required — the folder label |
| `accessType` | `Shared` (specified users only) / `Public` (all users incl. portal) / `PublicInternal` (all except portal) / `Hidden` |
| `publicFolderAccess` | With `Public` only: `ReadOnly` / `ReadWrite` |
| `folderShares` | Repeatable — one share per grantee, the enhanced-sharing mechanism below |

Each `<folderShares>`:

| Element | Values |
|---|---|
| `accessLevel` | `View` (run/refresh, no edit) / `EditAllContents` (view + modify contents) / `Manage` (all that, plus control others' access) |
| `sharedTo` | Developer name of the grantee (e.g. the public group or role name, or a username for `User`) |
| `sharedToType` | Commonly `Group`, `Role`, `RoleAndSubordinates`, `RoleAndSubordinatesInternal`, `User`, `Organization`; the full enum adds `Manager`, `ManagerAndSubordinatesInternal`, territory variants, portal/partner variants, and `ChannelProgramGroup` |

The grantees named in `sharedTo` must exist in the target org — check for a
share pointing at a missing group, role, or user before deploying.

## 8. Details that actually bite

- **Missing source report.** A dashboard whose `<report>` doesn't resolve in
  the target may still pass validation and then render broken or empty tiles —
  silent until a human opens it. Never treat a green validate as proof the
  wiring is right (§9); deploy the reports first or in the same package.
- **Missing folder.** `api_name`'s folder half must exist or ship in the
  package (§1). Same for the folder of every referenced report.
- **Invalid `runningUser` in the target** (§4) — check before, not after.
- **Modify = whole-document replace.** Deploying a Dashboard replaces the
  entire document: an element you omit is an element you removed. Always
  `retrieve_metadata` the current dashboard, edit that document, and redeploy
  it whole — never author a fragment from memory.
- **Char caps** silently matter: dashboard `title` is the identity shown in
  the UI, component `title` max 40, `header` max 80, `footer` and
  `description` max 255.
- **Filter column codes** are report-internal codes, not field API names (§6).

## 9. Workflow

1. **Ground** (§2): find the source reports, confirm they run, pick a
   retrieved dashboard as the structural template, verify folder + running
   user in the target.
2. **Author**: folder component (if new) + dashboard document; staging file +
   `content_file` in Claude Code, inline `content` in Desktop chat.
3. **Deploy**: one consolidated `validate_deploy` — folder, dashboard, and any
   reports it needs, one package, one approval. Dashboard-only packages carry
   no Apex: **omit `test_level` entirely** (production refuses an explicit
   `NoTestRun`). Lead the summary with the target org and the folder-sharing
   picture — who will see this dashboard and as whom it runs. Human reads the
   confirmation code from the approval page; `execute_deploy`; the full
   ritual is salesforce-house-rules §3.
4. **Refresh**: `refresh_snapshot` with `types: ["Dashboard"]` — Dashboard is
   an explicit-refresh-only type; the default sweep won't pick it up.
5. **Verify**: dashboards cannot be executed through Contrail. Run each
   underlying report with `get_report_data` (needs `data_read`) to prove the
   data the tiles will show, and `retrieve_metadata` the deployed dashboard to
   confirm the org kept what you sent. The final visual check — tiles actually
   rendering — needs a human to open the dashboard once; say so.
