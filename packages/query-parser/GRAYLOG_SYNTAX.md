# Graylog Query Syntax Support

The log correlator query parser now supports the full range of Graylog's native query syntax within correlation queries.

## Basic Query Structure

```
graylog(GRAYLOG_QUERY)[TIME_RANGE] CORRELATION_OPERATOR graylog(GRAYLOG_QUERY)[TIME_RANGE]
```

## Supported Graylog Query Features

### Field Names

Field names can contain:

- Letters (a-z, A-Z)
- Numbers (0-9)
- Underscores (\_)
- Hyphens (-)
- Dots (.)

Examples:

```
graylog(http-status-code:500)[10m]
graylog(kubernetes.namespace:production)[1h]
graylog(request_id:abc123)[5m]
```

### Boolean Operators

Combine multiple conditions using boolean logic:

#### AND Operator

```
graylog(tier:prd AND application:api)[1h]
```

#### OR Operator

```
graylog(level:error OR level:warn)[30m]
```

#### NOT Operator

```
graylog(NOT test-traffic:true)[1h]
```

#### Complex Boolean Expressions

Use parentheses to group conditions:

```
graylog((tier:prd AND app:api) OR (tier:staging AND debug:true))[1h]
```

### Special Operators

#### Existence Check

Check if a field exists in the log entry:

```
graylog(_exists_:request-id)[10m]
```

#### Missing Field Check

Check if a field is missing:

```
graylog(_missing_:error-code)[10m]
```

### Wildcards

Use asterisk (\*) for wildcard matching:

```
graylog(source:nginx*)[5m]
graylog(path:/api/*)[5m]
graylog(status:5*)[10m]
```

### Range Queries

Search for values within a range:

```
graylog(status:[400 TO 499])[30m]
graylog(response_time:[100 TO 1000])[1h]
```

### Comparison Operators

Use comparison operators for numeric fields:

```
graylog(response_time:>1000)[30m]
graylog(error_count:>=5)[1h]
graylog(cpu_usage:<80)[5m]
graylog(memory:<=4096)[10m]
```

### String Values

For values containing special characters, use quotes:

```
graylog(message:"Connection refused")[10m]
graylog(path:"/api/v1/users")[5m]
```

## Complete Correlation Examples

### Simple Correlation

```
graylog(tier:prd)[10m] and on(request_id) graylog(tier:staging)[10m]
```

### Complex Query with Boolean Logic

```
graylog((tier:prd AND _exists_:request-id) OR http-status-code:5*)[30m]
  and on(request-id)
graylog(NOT test:true)[30m]
```

### Multi-field Correlation

```
graylog(level:error AND service:api)[1h]
  and on(trace_id, session_id)
graylog(level:error AND service:database)[1h]
```

### Temporal Correlation

```
graylog(status:[500 TO 599])[30m]
  and on(request_id) within(5s)
graylog(level:error)[30m]
```

## Time Range Syntax

Time ranges are specified in square brackets after the query:

- `[30s]` - 30 seconds
- `[5m]` - 5 minutes
- `[1h]` - 1 hour
- `[24h]` - 24 hours
- `[7d]` - 7 days

## Correlation Operators

### Join Types

- `and on(field)` - Inner join (both streams must have matching records)
- `or on(field)` - Left join (include all from left, matching from right)
- `unless on(field)` - Anti-join (exclude records that match)

### Join Modifiers

- `within(duration)` - Temporal constraint for matching
- `group_left()` - Many-to-one matching from left
- `group_right()` - Many-to-one matching from right

## Notes

- Field names and values are case-sensitive
- Boolean operators (AND, OR, NOT) must be uppercase
- Special operators (_exists_, _missing_) must be lowercase
- Wildcards can appear anywhere in a value
- Range queries use inclusive boundaries
