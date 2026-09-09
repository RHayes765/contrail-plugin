# Common Authoring Errors

Read this when a generated `Report` component is rejected by `validate_deploy`
or fields don't appear in the report. Use these to validate the authored XML
before proposing the deploy.

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid report type 'X'` | Report type doesn't exist or isn't deployed in the target org | Verify the report type API name. For custom report types, ensure `<deployed>true</deployed>` is set. Use `platform-custom-report-type-generate` skill to create if missing |
| `Invalid field 'X' for report type 'Y'` | Column name not recognized for the report type — used raw field API name instead of platform column name | Use platform column names (e.g. `ACCOUNT_NAME` not `Account.Name`). For custom fields, use `ObjectApiName.FieldApiName__c`. Discover valid names by retrieving an existing report of the same report type via `retrieve_metadata` (see `column-names.md`) |
| Grouping field rejected / duplicated | A `<groupingsDown>` or `<groupingsAcross>` field ALSO appears as a `<columns>` entry | Remove the field from `<columns>` — grouped fields live only in the grouping blocks (SKILL.md Rule 13) |
| `Chart not valid for Tabular format` | `<chart>` element present on a Tabular report | Remove the chart or change format to `Summary` or `Matrix` |
| `Summary report requires at least one grouping` | Format is `Summary` but no `<groupingsDown>` is defined | Add at least one `<groupingsDown>` block or change format to `Tabular` |
| `Matrix report requires row and column groupings` | Format is `Matrix` but `<groupingsDown>` or `<groupingsAcross>` is missing | Add both row and column groupings |
| `Tabular report cannot have groupings` | `<groupingsDown>` or `<groupingsAcross>` present on a Tabular report | Remove groupings or change format to `Summary`/`Matrix` |
| `Invalid filter operator 'X'` | Typo or unsupported operator value | Use a valid operator from `filter-operations.md` |
| `Filter logic references filter N but only M filters exist` | `<booleanFilter>` references more criteria items than defined | Ensure the numbers in the logic match the actual criteria count |
| `Report folder not found` | The api_name's folder prefix names a folder that doesn't exist in the org, and no `ReportFolder` component ships in the package | Use an existing folder's developer name in the `Folder/Name` api_name, or add the `ReportFolder` component (with `folderShares`) to the same package |
| `Too many cross filters` | More than 3 `<crossFilters>` elements | Reduce to 3 or fewer cross-filters |
| `Joined report requires at least 2 blocks` | `<format>` is `Joined` but fewer than 2 `<block>` elements | Add at least 2 block elements |
| `Block format cannot be Tabular` | A `<block>` inside a Joined report has `<format>Tabular</format>` | Change block format to `Summary` or `Matrix` |
| `Aggregate types not valid for Tabular format` | `<aggregateTypes>` specified on a column in a Tabular report | Remove aggregates or change format to `Summary`/`Matrix` |
| `Invalid date interval 'X'` | Typo in `<interval>` value inside `<timeFrameFilter>` | Use a valid interval constant (e.g. `INTERVAL_CURRENT`, `INTERVAL_CURY`) |
| `Custom start/end date required for INTERVAL_CUSTOM` | Interval is `INTERVAL_CUSTOM` but `<startDate>` or `<endDate>` is missing | Add both `<startDate>` and `<endDate>` in `YYYY-MM-DD` format |

## Common Pitfalls

### Pitfall 1: Using API Field Names Instead of Platform Column Names

**Wrong:**
```xml
<columns>
    <field>Account.Name</field>  <!-- raw API name -->
</columns>
```

**Right:**
```xml
<columns>
    <field>ACCOUNT_NAME</field>  <!-- platform column name -->
</columns>
```

Standard fields have specific platform column names (e.g. `OPPORTUNITY_NAME`, `STAGE_NAME`, `CLOSE_DATE`). Custom fields use the format `ObjectApiName.FieldApiName__c`.

### Pitfall 2: Putting Grouping Fields in Columns

A field used in `<groupingsDown>` or `<groupingsAcross>` must NOT also appear
as a `<columns>` entry — that duplication is an automatic deployment failure
(SKILL.md Rule 13 and deployment killer #1). Grouped fields are declared only
in their grouping block.

### Pitfall 3: Mismatched Format and Structure

| If you want... | Use format | Must have |
|----------------|------------|-----------|
| Flat list | `Tabular` | Only `<columns>`, NO groupings |
| Grouped rows | `Summary` | `<columns>` + `<groupingsDown>` |
| Cross-tab | `Matrix` | `<columns>` + `<groupingsDown>` + `<groupingsAcross>` |
| Multi-source | `Joined` | `<block>` elements (2-5), each with own columns/groupings |

### Pitfall 4: Chart Summary Column Syntax

The `<summaryColumn>` in a chart uses a special syntax for aggregate references:
- `s!AMOUNT` — Sum of Amount
- `a!AMOUNT` — Average of Amount
- `m!AMOUNT` — Max of Amount
- `x!AMOUNT` — Min of Amount
- `RowCount` — Record count

### Pitfall 5: Joined Report Restrictions

- Joined reports do NOT support top-level `<chart>`, `<columns>`, or `<groupingsDown>` — everything goes inside `<block>` elements
- Each block must have its own `<reportType>` — blocks can use different report types
- Blocks align on common grouping fields for cross-block comparison
- Block format must be `Summary` or `Matrix`, never `Tabular`
