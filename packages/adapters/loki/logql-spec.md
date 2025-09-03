# LogQL Language Specification

## Overview

LogQL is Loki's PromQL-inspired query language used for querying logs. It supports two main query types:
- **Log queries**: Return log lines
- **Metric queries**: Extend log queries with aggregations to calculate values from logs

## Query Types

### 1. Log Stream Selector

The most basic LogQL query - selects log streams using label matchers.

```logql
{app="mysql", name="mysql-backup"}
```

#### Label Matchers
- `=`: Exactly equal
- `!=`: Not equal  
- `=~`: Regex match
- `!~`: Regex does not match

Examples:
```logql
{job="mysql"}                # Exactly equal
{name!="mysql"}               # Not equal
{job=~"mysql.+"}             # Regex match
{job!~"mysql.+"}             # Regex not match
{job=""}                      # Select logs without job label
```

### 2. Log Pipeline

Log queries can filter and parse logs through a pipeline of operations using the pipe (`|`) operator.

#### Line Filters

Filter log lines based on their content:

- `|=`: Line contains string
- `!=`: Line does not contain string
- `|~`: Line matches regex
- `!~`: Line does not match regex
- `|>`: Line contains pattern (faster than regex for simple patterns)
- `!>`: Line does not contain pattern

Examples:
```logql
{job="mysql"} |= "error"
{job="mysql"} != "debug"
{job="mysql"} |~ `\berror\b`
{job="mysql"} |> `<level=error>`
```

##### IP Line Filtering
Filter lines by IP addresses:
```logql
{job="mysql"} |= ip("192.168.1.0/24")
```

##### OR Expressions
Combine multiple filters:
```logql
{job="mysql"} |= "error" or "warning" or "fatal"
```

#### Parser Expressions

Extract labels from log content:

##### JSON Parser
```logql
{job="nginx"} | json
{job="nginx"} | json label="label_name"
{job="nginx"} | json label="label_name", another="field.path"
```

##### Logfmt Parser
```logql
{job="nginx"} | logfmt
{job="nginx"} | logfmt label="label_name"
{job="nginx"} | logfmt --strict --keep-empty label="name"
```

##### Pattern Parser
```logql
{job="nginx"} | pattern "<ip> <method> <path> <status>"
{job="nginx"} | pattern "<_> <method> <path>"  # _ ignores values
```

##### Regexp Parser
```logql
{job="nginx"} | regexp "(?P<ip>\\S+) (?P<method>\\S+) (?P<path>\\S+)"
```

##### Unpack Parser
For JSON or logfmt structured logs:
```logql
{job="nginx"} | unpack
```

#### Label Filters

Filter logs based on extracted label values:

##### Comparison Operators
- `==`, `!=`: Equality
- `>`, `>=`: Greater than
- `<`, `<=`: Less than

##### Types
- **Duration**: `1m`, `1h30s`
- **Bytes**: `10KB`, `1MB`, `1GB`
- **Numbers**: `200`, `3.14`
- **IP**: `ip("192.168.1.0/24")`

Examples:
```logql
{job="nginx"} | json | status >= 400
{job="nginx"} | logfmt | duration > 1s
{job="nginx"} | json | bytes_sent > 10KB
{job="nginx"} | json | client_ip = ip("192.168.0.0/16")
```

#### Line Format Expression

Format output lines using Go templates:
```logql
{job="nginx"} | line_format "{{.ip}} {{.status}} {{.path}}"
{job="nginx"} | line_format "{{.error | ToUpper}}"
```

#### Label Format Expression

Rename, modify or add labels:
```logql
{job="nginx"} | label_format level="error", type="backend"
{job="nginx"} | label_format new_label="{{.label1}}-{{.label2}}"
```

#### Decolorize Expression

Remove ANSI color codes:
```logql
{job="nginx"} | decolorize
```

#### Drop/Keep Labels

Control which labels to retain:
```logql
{job="nginx"} | json | drop level, namespace
{job="nginx"} | json | keep status, method, path
```

### 3. Metric Queries

Metric queries aggregate log data to calculate values.

#### Log Range Aggregations

Apply functions to log streams over time ranges:

##### Count Operations
```logql
count_over_time({job="mysql"}[5m])           # Count of logs
rate({job="mysql"}[5m])                      # Per-second rate
rate_counter({job="mysql"}[5m])              # Rate for counter resets
```

##### Bytes Operations
```logql
bytes_over_time({job="nginx"}[5m])           # Total bytes
bytes_rate({job="nginx"}[5m])                # Bytes per second
```

##### Absent Detection
```logql
absent_over_time({job="mysql"}[5m])          # 1 if no logs, 0 otherwise
```

#### Unwrap Expressions

Convert log lines to numeric samples:

```logql
{job="nginx"} | json | unwrap request_time [5m]
{job="nginx"} | logfmt | unwrap bytes_sent [5m]
```

##### Conversion Functions
- `bytes()`: Convert to bytes (supports KB, MB, GB)
- `duration()`: Convert to duration 
- `duration_seconds()`: Convert to seconds

```logql
{job="nginx"} | json | unwrap bytes(response_size) [5m]
{job="nginx"} | json | unwrap duration(request_time) [5m]
```

#### Unwrapped Range Aggregations

Apply functions to unwrapped values:

```logql
sum_over_time({job="nginx"} | unwrap bytes_sent [5m])
avg_over_time({job="nginx"} | unwrap request_time [5m])
max_over_time({job="nginx"} | unwrap response_size [5m])
min_over_time({job="nginx"} | unwrap latency [5m])
stddev_over_time({job="nginx"} | unwrap duration [5m])
stdvar_over_time({job="nginx"} | unwrap duration [5m])
quantile_over_time(0.95, {job="nginx"} | unwrap latency [5m])
first_over_time({job="nginx"} | unwrap value [5m])
last_over_time({job="nginx"} | unwrap value [5m])
```

### 4. Vector Aggregations

Aggregate metrics across label dimensions:

```logql
sum(rate({job="nginx"}[5m])) by (status)
avg(rate({job="nginx"}[5m])) by (method)
max(rate({job="nginx"}[5m])) by (path)
min(rate({job="nginx"}[5m]))
count(rate({job="nginx"}[5m]))
stddev(rate({job="nginx"}[5m]))
stdvar(rate({job="nginx"}[5m]))
```

#### Top/Bottom K
```logql
topk(3, rate({job="nginx"}[5m]))
bottomk(5, rate({job="nginx"}[5m]))
```

#### Grouping
- `by`: Include only listed labels
- `without`: Exclude listed labels

```logql
sum by (job, status) (rate({job="nginx"}[5m]))
sum without (instance) (rate({job="nginx"}[5m]))
```

### 5. Binary Operators

Combine multiple expressions:

#### Arithmetic
```logql
rate({job="nginx"}[5m]) * 60                    # Scalar multiplication
sum(rate({job="app1"}[5m])) + sum(rate({job="app2"}[5m]))
sum(rate({job="nginx"}[5m])) / count(rate({job="nginx"}[5m]))
```

#### Comparison
```logql
rate({job="nginx"}[5m]) > 100
rate({job="nginx"}[5m]) >= bool 100  # Returns 1 or 0
```

#### Logical
```logql
rate({job="nginx"}[5m]) and rate({job="mysql"}[5m])
rate({job="nginx"}[5m]) or rate({job="mysql"}[5m])
rate({job="nginx"}[5m]) unless rate({job="mysql"}[5m])
```

#### Vector Matching

Control how vectors are combined:

##### One-to-One
```logql
rate({job="nginx"}[5m]) * on(instance) rate({job="mysql"}[5m])
rate({job="nginx"}[5m]) / ignoring(job) rate({job="mysql"}[5m])
```

##### Many-to-One
```logql
rate({job="nginx"}[5m]) * on(cluster) group_left(job) cluster_capacity
rate({job="nginx"}[5m]) * on(cluster) group_right(job) cluster_capacity
```

### 6. Functions

#### label_replace()

Dynamically set label values using regex:
```logql
label_replace(
  rate({job="api"}[5m]),
  "job_type",           # Target label
  "$1",                 # Replacement
  "job",                # Source label  
  "(\\w+)_.*"          # Regex
)
```

#### vector()

Create a scalar vector:
```logql
vector(1)  # Returns scalar value 1 as a vector
```

### 7. Modifiers

#### Offset Modifier

Query data from the past:
```logql
rate({job="nginx"}[5m] offset 1h)        # Rate from 1 hour ago
{job="nginx"} |= "error" offset 24h      # Logs from 24 hours ago
```

### 8. Comments

```logql
# This is a comment
{job="nginx"}  # Inline comment
```

## Pipeline Order

The pipeline operations must follow this order:
1. Log Stream Selector
2. Line Filters
3. Parser (json, logfmt, pattern, regexp, unpack)
4. Label Filters  
5. Line/Label Format
6. Unwrap (for metric queries)

## Special Syntax

### Backticks for Raw Strings
Use backticks for raw strings to avoid escaping:
```logql
{job="nginx"} |~ `\d+\.\d+\.\d+\.\d+`  # IP regex
```

### Duration Units
- `ns`: Nanoseconds
- `us`/`µs`: Microseconds
- `ms`: Milliseconds
- `s`: Seconds
- `m`: Minutes
- `h`: Hours
- `d`: Days
- `w`: Weeks
- `y`: Years (365 days)

### Bytes Units
- `B`: Bytes
- `KB`/`KiB`: Kilobytes
- `MB`/`MiB`: Megabytes
- `GB`/`GiB`: Gigabytes
- `TB`/`TiB`: Terabytes
- `PB`/`PiB`: Petabytes

## Operator Precedence

From highest to lowest:
1. `^` (power)
2. `*`, `/`, `%` (multiplication, division, modulo)
3. `+`, `-` (addition, subtraction)
4. `==`, `!=`, `<`, `<=`, `>`, `>=` (comparison)
5. `and`, `unless` (logical AND, UNLESS)
6. `or` (logical OR)

## Query Examples

### Finding Errors
```logql
{app="frontend"} |= "error" != "debug"
```

### Parsing and Filtering JSON
```logql
{app="nginx"} 
  | json 
  | status >= 400 
  | line_format "{{.timestamp}} {{.method}} {{.path}} {{.status}}"
```

### Calculating Request Rate by Status
```logql
sum by (status) (
  rate({job="nginx"} | json | status != "" [5m])
)
```

### P95 Latency
```logql
quantile_over_time(0.95,
  {job="api"} 
    | json 
    | unwrap latency_ms [5m]
) by (endpoint)
```

### Bytes Processed Per Hour
```logql
sum(
  bytes_rate({job="processor"} 
    | json 
    | unwrap bytes_processed [1h])
)
```

### Alert on Missing Logs
```logql
absent_over_time({job="critical-service"}[5m]) > 0
```

## Grammar Structure

The LogQL grammar follows this hierarchy:
```
expr
├── logExpr (returns logs)
│   ├── selector + pipeline
│   └── (logExpr)
├── metricExpr (returns metrics)
│   ├── rangeAggregationExpr
│   ├── vectorAggregationExpr
│   ├── binOpExpr
│   ├── literalExpr
│   └── (metricExpr)
└── variantsExpr (experimental)
```

## Reserved Keywords

The following are reserved keywords in LogQL:
- Aggregations: `sum`, `avg`, `max`, `min`, `count`, `stddev`, `stdvar`, `topk`, `bottomk`
- Functions: `rate`, `count_over_time`, `bytes_over_time`, `bytes_rate`, `absent_over_time`
- Parsers: `json`, `logfmt`, `pattern`, `regexp`, `unpack`
- Filters: `by`, `without`, `on`, `ignoring`, `group_left`, `group_right`
- Operators: `and`, `or`, `unless`, `bool`, `offset`
- Formatters: `line_format`, `label_format`, `decolorize`, `drop`, `keep`
- Special: `unwrap`, `ip`, `bytes`, `duration`, `duration_seconds`