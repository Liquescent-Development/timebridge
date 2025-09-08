# TimeQL Language Specification

## Overview

TimeQL (Time Query Language) is a domain-specific query language designed for correlating and querying time-series data across multiple observability platforms. It extends PromQL-inspired syntax with time-focused operations optimized for TimeBuddy and other time-series analysis tools.

## Design Principles

1. **Time-First**: Every operation is inherently time-aware
2. **Platform Agnostic**: Works across logs, metrics, and time-series databases
3. **Composable**: Complex queries built from simple operations
4. **Streaming-Compatible**: Designed for real-time and historical analysis
5. **Human-Readable**: Intuitive syntax that reads like natural language

## Core Syntax

### Basic Query Structure

```timeql
SOURCE(SELECTOR)[TIME_RANGE] [OPERATOR] SOURCE(SELECTOR)[TIME_RANGE]
```

- **SOURCE**: Data source identifier (e.g., `graylog`, `prometheus`, `influxdb`)
- **SELECTOR**: Source-specific query syntax
- **TIME_RANGE**: Time window for data retrieval
- **OPERATOR**: Correlation or transformation operator

### Time Range Syntax

Time ranges use duration literals:

- `s` - seconds (e.g., `30s`)
- `m` - minutes (e.g., `5m`)
- `h` - hours (e.g., `2h`)
- `d` - days (e.g., `7d`)
- `w` - weeks (e.g., `2w`)

## Query Types

### 1. Direct Queries

Retrieve data from a single source:

```timeql
# Get Graylog errors from last 5 minutes
graylog(level:error)[5m]

# Get Prometheus metrics for last hour
prometheus(cpu_usage{job="api"})[1h]

# Get InfluxDB time-series for last day
influxdb(SELECT * FROM temperature)[1d]
```

### 2. Correlation Queries

Join data across multiple sources:

```timeql
# Inner join on request_id
prometheus(http_requests_total{status="500"})[10m]
  and on(request_id)
graylog(level:error)[10m]

# Left join on trace_id
influxdb(SELECT * FROM traces)[5m]
  or on(trace_id)
loki({service="api"})[5m]

# Anti-join on session_id
graylog(service:frontend)[15m]
  unless on(session_id)
graylog(service:backend)[15m]
```

## Operators

### Correlation Operators

#### `and on(keys)`

Inner join - returns events that exist in both streams with matching keys.

```timeql
sourceA(query)[5m] and on(request_id) sourceB(query)[5m]
```

#### `or on(keys)`

Left join - returns all events from left stream, with matching events from right.

```timeql
sourceA(query)[5m] or on(trace_id) sourceB(query)[5m]
```

#### `unless on(keys)`

Anti-join - returns events from left stream that have no match in right stream.

```timeql
sourceA(query)[5m] unless on(session_id) sourceB(query)[5m]
```

### Time Range Specifications

#### Relative Time Ranges (Legacy)

Query the last N units of time from now:

```timeql
graylog(service:api)[5m]    # Last 5 minutes
loki({app="frontend"})[1h]  # Last 1 hour  
events{service="auth"}[7d]  # Last 7 days
```

#### Absolute Time Ranges

Query a specific time period using ISO 8601 timestamps:

```timeql
# Full ISO timestamps with UTC
graylog(service:api)[2024-01-15T10:00:00Z to 2024-01-15T18:00:00Z]

# With timezone offsets
loki({app="frontend"})[2024-01-15T10:00:00-07:00 to 2024-01-15T18:00:00-07:00]

# Date-only (defaults to midnight UTC)
events{service="auth"}[2024-01-15 to 2024-01-16]
```

#### Mixed Relative/Absolute Ranges

Combine absolute and relative time references:

```timeql
# From absolute time to now
graylog(service:api)[2024-01-15T10:00:00Z to now]

# From relative past to absolute time
loki({app="frontend"})[1d ago to 2024-01-15T18:00:00Z]

# From absolute time plus duration
events{}[2024-01-15T10:00:00Z to +8h]
```

#### @ Modifier (Point-in-Time)

Query at or from a specific timestamp:

```timeql
# At specific time (point query)
graylog(service:api) @ 2024-01-15T10:00:00Z

# Range from specific time  
loki({app="frontend"})[1h] @ 2024-01-15T10:00:00Z  # 1 hour from timestamp

# Combined with absolute range
events{}[2024-01-15T09:00:00Z to 2024-01-15T10:00:00Z] @ 2024-01-15T10:00:00Z
```

### Time Operators

#### `within(duration)`

Events must occur within specified time window of each other.

```timeql
sourceA(query)[5m] and on(id) within(30s) sourceB(query)[5m]
```

#### `align on(timestamp)`

Align events by timestamp rather than correlation keys.

```timeql
prometheus(metric)[1h] align on(timestamp) influxdb(SELECT * FROM data)[1h]
```

#### `timeshift(duration)`

Shift time window for comparison with historical data.

```timeql
prometheus(errors)[1h]
  and on(service)
prometheus(errors)[1h] timeshift(1d)
```

### Aggregation Operators

#### `group_left(labels)`

Many-to-one join keeping left labels.

```timeql
prometheus(instance_cpu)[5m]
  and on(instance) group_left(region, zone)
prometheus(instance_metadata)[5m]
```

#### `group_right(labels)`

One-to-many join keeping right labels.

```timeql
graylog(service:api)[10m]
  and on(service) group_right()
graylog(service:*)[10m]
```

## Advanced Features

### Multi-Source Correlation

Correlate across three or more sources:

```timeql
prometheus(http_latency_seconds)[10m]
  and on(trace_id)
influxdb(SELECT * FROM db_queries)[10m]
  and on(trace_id)
graylog(level:error)[10m]
  and on(trace_id)
loki({job="nginx"})[10m]
```

### Temporal Windows

Specify different time windows for correlation:

```timeql
# Find errors that occur within 1 minute after high CPU
prometheus(cpu > 90)[30m]
  and on(host) after(1m)
graylog(level:error)[30m]
```

### Field Mapping

Map different field names between sources:

```timeql
sourceA(query)[5m]
  and on(request_id=req_id, host=hostname)
sourceB(query)[5m]
```

### Filtering

Apply filters to correlated results:

```timeql
(prometheus(errors)[5m]
  and on(service)
graylog(level:error)[5m])
  | filter(correlation.events.length > 10)
```

## Source-Specific Selectors

### Graylog Selector

Uses Graylog query syntax:

```timeql
graylog(level:error AND service:api)[5m]
graylog(message:"connection timeout" AND host:prod-*)[10m]
graylog(status:[500 TO 599] AND _exists_:request_id)[1h]
```

### Loki Selector (LogQL)

Uses LogQL syntax:

```timeql
loki({job="nginx", level="error"})[5m]
loki({namespace="production"} |= "timeout")[10m]
loki({app="api"} | json | latency > 1000)[1h]
```

### Prometheus Selector (PromQL)

Uses PromQL syntax:

```timeql
prometheus(up{job="api"})[5m]
prometheus(rate(http_requests_total[5m]))[10m]
prometheus(histogram_quantile(0.99, http_duration_bucket))[1h]
```

### InfluxDB Selector

Uses InfluxQL or Flux syntax:

```timeql
# InfluxQL (1.x)
influxdb(SELECT mean(cpu) FROM system WHERE host = 'server1')[5m]

# Flux (2.x)
influxdb(from(bucket: "metrics") |> filter(fn: (r) => r._measurement == "cpu"))[5m]
```

## Time Window Specifications

### Relative Time

Most common - relative to current time:

```timeql
source(query)[5m]    # Last 5 minutes
source(query)[1h]    # Last 1 hour
source(query)[7d]    # Last 7 days
```

### Absolute Time (Future Enhancement)

Specify exact time ranges:

```timeql
source(query)[2024-01-01T00:00:00Z to 2024-01-01T23:59:59Z]
source(query)[yesterday to now]
source(query)[@1704067200 to @1704153600]  # Unix timestamps
```

### Rolling Windows (Future Enhancement)

Continuous time windows:

```timeql
source(query)[rolling 5m every 1m]  # 5-minute window, update every minute
```

## Query Composition

### Subqueries

Use query results as input to another query:

```timeql
prometheus(
  avg_over_time(
    prometheus(cpu_usage)[5m:1m]
  )
)[1h]
```

### Query Variables (Future Enhancement)

Define reusable query components:

```timeql
let $services = graylog(service:*)[10m];
let $errors = graylog(level:error)[10m];

$services unless on(service) $errors
```

## Performance Hints

### Limit Results

Specify maximum events to process:

```timeql
source(query)[5m] limit 1000
```

### Sampling

Sample data for faster queries:

```timeql
source(query)[1d] sample 0.1  # Sample 10% of data
```

### Parallel Execution

Hint for parallel query execution:

```timeql
parallel {
  prometheus(cpu)[5m],
  graylog(level:error)[5m],
  influxdb(SELECT * FROM metrics)[5m]
} and on(host)
```

## Error Handling

### Query Validation

TimeQL validates:

1. Source availability
2. Syntax correctness
3. Time range validity
4. Field compatibility for joins

### Partial Results

Queries can return partial results with metadata:

```json
{
  "completeness": "partial",
  "matchedStreams": ["prometheus", "graylog"],
  "failedStreams": ["influxdb"],
  "error": "influxdb: connection timeout"
}
```

## Examples

### SLO Monitoring

```timeql
# Monitor 99th percentile latency SLO
prometheus(
  histogram_quantile(0.99, http_request_duration_seconds_bucket)
)[10m]
  and on(service) within(1m)
graylog(level:error OR level:warn)[10m]
```

### Incident Investigation

```timeql
# Trace an incident across the stack
graylog(message:"OutOfMemoryError")[1h]
  and on(instance) before(5m)
prometheus(memory_usage_percent > 90)[1h]
  and on(instance)
influxdb(SELECT * FROM gc_pauses WHERE duration > 1000)[1h]
```

### Capacity Planning

```timeql
# Correlate resource usage with request volume
prometheus(
  predict_linear(cpu_usage[1h], 86400)
)[1d]
  align on(timestamp)
influxdb(
  SELECT forecast(requests_per_second, 10) FROM api_metrics
)[1d]
```

### Cost Analysis

```timeql
# Correlate cloud costs with application metrics
influxdb(SELECT * FROM aws_costs)[30d]
  and on(service)
prometheus(sum by (service)(container_cpu_usage_seconds_total))[30d]
  and on(service)
graylog(service:* AND event:"scaled_up")[30d]
```

## Future Enhancements

1. **Machine Learning Operations**: `anomaly()`, `predict()`, `forecast()`
2. **Geospatial Queries**: `near()`, `within_radius()`, `geo_cluster()`
3. **Pattern Matching**: `pattern()`, `sequence()`, `follows()`
4. **Statistical Functions**: `correlation()`, `regression()`, `stddev()`
5. **Alert Integration**: `alert when`, `notify via`

## Implementation Notes

### Parser

The TimeQL parser is implemented using Peggy (PEG.js) grammar for:

- Fast parsing
- Clear error messages
- Easy extension
- Browser compatibility

### Query Planner

The query planner optimizes:

- Source query order
- Time window alignment
- Memory usage
- Parallel execution

### Streaming Engine

The streaming engine provides:

- Async iteration
- Back-pressure handling
- Memory bounds
- Progress reporting

## Backward Compatibility

TimeQL maintains backward compatibility with the original PromQL-inspired syntax while adding new time-focused features. Existing queries continue to work without modification.

## Conclusion

TimeQL provides a powerful, intuitive language for time-series data correlation that serves as the query foundation for TimeBridge and TimeBuddy, enabling sophisticated observability workflows across heterogeneous data sources.
