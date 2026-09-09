# Filter Operators Reference

The `<operator>` element in a `<criteriaItems>` block determines how the field
value is compared. Use these values exactly as shown. (The element name is
`<operator>` — `<operation>` belongs to cross-filters only, where its values
are `with`/`without`.)

## Text & Picklist Operators

| Operator | Description | `<value>` Required | Example |
|-----------|-------------|-------------------|---------|
| `equals` | Exact match (case-insensitive for text) | Yes | `<value>Closed Won</value>` |
| `notEqual` | Does not equal | Yes | `<value>Closed Lost</value>` |
| `contains` | Contains substring | Yes | `<value>Enterprise</value>` |
| `notContain` | Does not contain substring | Yes | `<value>Test</value>` |
| `startsWith` | Starts with prefix | Yes | `<value>Acme</value>` |

## Numeric & Currency Operators

| Operator | Description | `<value>` Required | Example |
|-----------|-------------|-------------------|---------|
| `equals` | Equal to | Yes | `<value>100000</value>` |
| `notEqual` | Not equal to | Yes | `<value>0</value>` |
| `lessThan` | Less than | Yes | `<value>50000</value>` |
| `greaterThan` | Greater than | Yes | `<value>100000</value>` |
| `lessOrEqual` | Less than or equal to | Yes | `<value>50000</value>` |
| `greaterOrEqual` | Greater than or equal to | Yes | `<value>100000</value>` |

## Multi-Select Picklist Operators

| Operator | Description | `<value>` Required | Example |
|-----------|-------------|-------------------|---------|
| `includes` | Includes any of the specified values | Yes | `<value>Web;Phone</value>` (semicolon-separated) |
| `excludes` | Excludes all of the specified values | Yes | `<value>Other;Unknown</value>` |

## Blank / Null Operators

| Operator | Description | `<value>` Required | Example |
|-----------|-------------|-------------------|---------|
| `isBlank` | Field is null or empty | No | (no `<value>` element needed) |
| `notBlank` | Field is not null and not empty | No | (no `<value>` element needed) |

```xml
<filter>
    <criteriaItems>
        <column>ACCOUNT_NAME</column>
        <operator>notBlank</operator>
    </criteriaItems>
</filter>
```

## Geolocation Operators

| Operator | Description | `<value>` Required | Example |
|-----------|-------------|-------------------|---------|
| `within` | Within specified distance | Yes | `<value>DISTANCE(BillingAddress, GEOLOCATION(37.7749,-122.4194), 'mi') < 50</value>` |

## Multiple Values in a Single Filter

For `equals` and `notEqual` operators on picklist fields, separate multiple values with commas:
```xml
<filter>
    <criteriaItems>
        <column>STAGE_NAME</column>
        <operator>notEqual</operator>
        <value>Closed Won,Closed Lost</value>
    </criteriaItems>
</filter>
```

## Filter Logic

Use `<booleanFilter>` (inside `<filter>`) to combine criteria with AND/OR/NOT
logic. Criteria items are numbered starting from 1 in the order they appear in
the XML.

```xml
<filter>
    <booleanFilter>1 AND (2 OR 3)</booleanFilter>
    <criteriaItems>
        <column>STAGE_NAME</column>
        <operator>equals</operator>
        <value>Prospecting</value>
    </criteriaItems>
    <criteriaItems>
        <column>AMOUNT</column>
        <operator>greaterThan</operator>
        <value>10000</value>
    </criteriaItems>
    <criteriaItems>
        <column>LEAD_SOURCE</column>
        <operator>equals</operator>
        <value>Web</value>
    </criteriaItems>
</filter>
```

**Rules:**
- Every criteria item must be referenced in the logic expression
- Parentheses control evaluation order
- Supported operators: `AND`, `OR`, `NOT`
- Maximum 20 filter criteria per report
- Without `<booleanFilter>`, all criteria are combined with AND
