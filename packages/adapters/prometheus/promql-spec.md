# PromQL Language Specification

## Overview

PromQL (Prometheus Query Language) is a functional query language that allows users to select and aggregate time series data in real-time. This specification documents the complete PromQL syntax for implementing a parser.

## 1. Basic Types

### 1.1 Numbers

PromQL supports various number formats:

- **Integers**: `123`, `0`, `-456`
- **Floats**: `123.456`, `.5`, `5.`, `-0.5`
- **Scientific notation**: `5e-3`, `5e3`, `+5.5e-3`
- **Hexadecimal**: `0xc` (12 in decimal)
- **Octal**: `0755` (493 in decimal)
- **Special values**: `+Inf`, `-Inf`, `NaN`

### 1.2 Strings

Strings can be quoted with various styles:
- **Single quotes**: `'string value'`
- **Double quotes**: `"string value"`
- **Backticks**: `` `string value` ``
- **Escape sequences**: `\"`, `\\`, `\n`, `\t`, etc.

### 1.3 Durations

Time durations with units:
- `5s` - 5 seconds
- `30m` - 30 minutes  
- `1h` - 1 hour
- `1d` - 1 day
- `1w` - 1 week
- `1y` - 1 year
- Combined: `1h30m`, `2d12h`

## 2. Selectors

### 2.1 Instant Vector Selectors

Select a set of time series at a single point in time:

```promql
metric_name
metric_name{label1="value1", label2="value2"}
{__name__="metric_name", label1="value1"}
{label1="value1", label2!="value2"}
```

### 2.2 Label Matchers

Label matching operators:
- `=` : Select labels that are exactly equal
- `!=` : Select labels that are not equal
- `=~` : Select labels that regex-match
- `!~` : Select labels that do not regex-match

Examples:
```promql
http_requests{method="GET"}
http_requests{status!="200"}
http_requests{path=~"/api/.*"}
http_requests{error!~"timeout|cancelled"}
```

### 2.3 Range Vector Selectors

Select a range of samples back from the current instant:

```promql
metric_name[5m]
metric_name{label="value"}[30s]
rate(http_requests[5m])
```

### 2.4 Time Modifiers

#### Offset Modifier
Query data from the past:
```promql
http_requests offset 5m
http_requests[1h] offset 1d
rate(http_requests[5m] offset 10m)
```

#### @ Modifier
Query at a specific timestamp:
```promql
http_requests @ 1609746000
http_requests @ start()
http_requests @ end()
```

## 3. Operators

### 3.1 Arithmetic Operators

Binary arithmetic operators (in order of precedence):
1. `^` : Power
2. `*`, `/`, `%` : Multiplication, division, modulo
3. `+`, `-` : Addition, subtraction

Examples:
```promql
metric1 + metric2
metric * 2
10 - metric
metric1 / metric2
```

### 3.2 Comparison Operators

- `==` : Equal
- `!=` : Not equal
- `>` : Greater than
- `<` : Less than
- `>=` : Greater than or equal
- `<=` : Less than or equal

With `bool` modifier to return 0/1 instead of filtering:
```promql
metric > 100
metric <= 50
metric == bool 10
```

### 3.3 Logical/Set Operators

- `and` : Intersection
- `or` : Union
- `unless` : Complement

Examples:
```promql
metric1 and metric2
metric1 or metric2
metric1 unless metric2
```

### 3.4 Vector Matching

#### One-to-one matching
```promql
metric1 + on(label1, label2) metric2
metric1 * ignoring(label3) metric2
```

#### One-to-many/many-to-one matching
```promql
metric1 * on(instance) group_left(job, version) metric2
metric1 / on(cluster) group_right metric2
```

## 4. Aggregation Operators

Aggregation operators can aggregate along dimensions:

### 4.1 Aggregation Functions

- `sum` : Calculate sum
- `min` : Select minimum  
- `max` : Select maximum
- `avg` : Calculate average
- `stddev` : Calculate standard deviation
- `stdvar` : Calculate standard variance
- `count` : Count number of elements
- `count_values` : Count number of elements with same value
- `bottomk` : Smallest k elements by value
- `topk` : Largest k elements by value
- `quantile` : Calculate φ-quantile

### 4.2 Aggregation Syntax

```promql
<aggr-op>([parameter,] <vector expression>) [without|by (<label list>)]
<aggr-op> [without|by (<label list>)] ([parameter,] <vector expression>)
```

Examples:
```promql
sum(http_requests)
sum by (job)(http_requests)
sum without (instance)(http_requests)
topk(5, http_requests)
quantile(0.95, http_requests)
```

## 5. Functions

### 5.1 Rate Functions

- `rate()` : Per-second average rate of increase
- `irate()` : Instantaneous rate of increase
- `increase()` : Increase in value
- `delta()` : Difference between first and last value
- `idelta()` : Difference between last two samples

### 5.2 Mathematical Functions

- `abs()` : Absolute value
- `ceil()` : Round up to nearest integer
- `floor()` : Round down to nearest integer
- `round()` : Round to nearest integer
- `sqrt()` : Square root
- `exp()` : Exponential function
- `ln()`, `log2()`, `log10()` : Logarithm functions

### 5.3 Trigonometric Functions

- `sin()`, `cos()`, `tan()` : Basic trig functions
- `asin()`, `acos()`, `atan()` : Inverse trig functions
- `sinh()`, `cosh()`, `tanh()` : Hyperbolic functions
- `asinh()`, `acosh()`, `atanh()` : Inverse hyperbolic
- `deg()`, `rad()` : Degree/radian conversion
- `pi()` : Pi constant

### 5.4 Date/Time Functions

- `day_of_month()` : Day of the month (1-31)
- `day_of_week()` : Day of the week (0-6, 0 is Sunday)
- `day_of_year()` : Day of the year (1-365/366)
- `days_in_month()` : Number of days in month
- `hour()` : Hour of the day (0-23)
- `minute()` : Minute of the hour (0-59)
- `month()` : Month of the year (1-12)
- `year()` : Year
- `time()` : Current Unix timestamp
- `timestamp()` : Timestamp of each sample

### 5.5 Label Functions

- `label_join()` : Join label values
- `label_replace()` : Replace label values using regex

### 5.6 Vector Functions

- `vector()` : Return scalar as vector
- `scalar()` : Return single-element vector as scalar
- `sort()` : Sort vector elements
- `sort_desc()` : Sort in descending order
- `absent()` : Return 1 if vector is empty
- `absent_over_time()` : Return 1 if range vector is empty

### 5.7 Histogram Functions

- `histogram_quantile()` : Calculate quantile from histogram
- `histogram_count()` : Extract count from histogram
- `histogram_sum()` : Extract sum from histogram
- `histogram_fraction()` : Calculate fraction between bounds
- `histogram_stddev()` : Calculate standard deviation
- `histogram_stdvar()` : Calculate standard variance

### 5.8 Prediction Functions

- `predict_linear()` : Predict value using linear regression
- `deriv()` : Calculate derivative using linear regression
- `holt_winters()` : Smooth time series data

### 5.9 Information Functions

- `up()` : Target up status (0/1)
- `info()` : Return info metric samples

## 6. Subqueries

Execute a query for a range and return a range vector:

```promql
<instant_query>[<range>:<resolution>]
```

Examples:
```promql
rate(http_requests[5m])[30m:1m]
max_over_time(rate(http_requests[5m])[30m:])
```

## 7. Comments

Comments start with `#`:
```promql
# This is a comment
http_requests # This is also a comment
```

## 8. Precedence

Operator precedence from highest to lowest:

1. `^`
2. `*`, `/`, `%`, `atan2`
3. `+`, `-`
4. `==`, `!=`, `<=`, `<`, `>=`, `>`
5. `and`, `unless`
6. `or`

## 9. Type System

PromQL has four data types:

1. **Scalar**: Simple numeric floating point value
2. **String**: Simple string value  
3. **Instant Vector**: Set of time series with single sample per series
4. **Range Vector**: Set of time series with range of samples per series

## 10. Special Considerations

### 10.1 Staleness Handling

Prometheus has a sophisticated staleness handling mechanism where series are marked stale after 5 minutes of no new samples.

### 10.2 Lookback Delta

The maximum time to look back for samples (default 5 minutes).

### 10.3 Unicode Support

PromQL supports Unicode in:
- Comments
- String literals  
- Label values
- Metric names (with limitations)

### 10.4 Native Histograms

Support for native histogram types with special bucket notation:
```promql
{{schema:1 sum:2.5 count:4 buckets:[1 2 1]}}
```

## 11. Grammar Rules Summary

```
expression     : term (binary_op term)*
term           : factor | aggregation | function_call | vector_selector
vector_selector: metric_identifier label_matchers? modifiers?
label_matchers : '{' label_matcher (',' label_matcher)* '}'
label_matcher  : label_name match_op string
modifiers      : offset_mod? at_mod?
offset_mod     : 'offset' duration
at_mod         : '@' (number | 'start()' | 'end()')
range_selector : vector_selector '[' duration ']'
subquery       : expression '[' duration ':' duration? ']'
aggregation    : aggr_op aggr_modifier? '(' expression ')'
aggr_modifier  : ('by' | 'without') '(' label_list ')'
function_call  : function_name '(' arg_list ')'
```

## 12. Error Handling

Common parse errors:
- Unclosed brackets/parentheses
- Invalid label matcher syntax
- Unknown functions
- Type mismatches
- Invalid duration formats
- Illegal operations (e.g., range vector in binary operation)

## References

- [Official PromQL Documentation](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [PromQL Operators](https://prometheus.io/docs/prometheus/latest/querying/operators/)  
- [PromQL Functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)