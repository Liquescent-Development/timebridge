# Graylog Query Language Specification

This document defines the Graylog Query Language syntax and semantics. It serves as the authoritative reference for implementing Graylog query parsers and validators.

## Table of Contents

1. [Overview](#overview)
2. [Basic Syntax](#basic-syntax)
3. [Field Queries](#field-queries)
4. [Boolean Operators](#boolean-operators)
5. [Wildcards](#wildcards)
6. [Regular Expressions](#regular-expressions)
7. [Fuzzy Searches](#fuzzy-searches)
8. [Range Queries](#range-queries)
9. [Special Fields](#special-fields)
10. [Escaping](#escaping)
11. [Time Ranges](#time-ranges)
12. [Aggregations](#aggregations)
13. [Grammar Definition](#grammar-definition)

## Overview

The Graylog query syntax is based on Lucene syntax with some modifications and extensions. By default, all message fields are included in searches unless a specific field is specified.

## Basic Syntax

### Simple Term Search

```
ssh                    # Messages containing "ssh"
ssh login             # Messages containing "ssh" OR "login" (default OR)
"ssh login"           # Messages containing exact phrase "ssh login"
```

### Comments

Comments are not supported in Graylog queries.

## Field Queries

### Basic Field Queries

```
type:ssh              # Field "type" contains "ssh"
type:(ssh OR login)   # Field "type" contains "ssh" OR "login"
type:"ssh login"      # Field "type" contains exact phrase "ssh login"
```

### Field Existence

```
_exists_:type         # Messages that have the field "type"
NOT _exists_:type     # Messages that do not have field "type"
```

## Boolean Operators

Boolean operators must be uppercase:

- `AND` - Both conditions must match
- `OR` - At least one condition must match (default)
- `NOT` - Negates a condition

### Examples

```
"ssh login" AND source:example.org
"ssh login" AND (source:example.org OR source:another.example.org)
"ssh login" OR _exists_:always_find_me
"ssh login" AND NOT source:example.org
NOT example.org
```

### Precedence

1. Parentheses `()`
2. `NOT`
3. `AND`
4. `OR`

## Wildcards

- `?` - Matches single character
- `*` - Matches zero or more characters

### Examples

```
source:*.org          # Matches any .org domain
source:exam?le.org    # Matches example.org or examXle.org
source:exam?le.*      # Combines single char and multi-char wildcards
```

### Restrictions

- Leading wildcards are disabled by default (can be enabled in configuration)
- Analyzed fields (`message`, `full_message`, `source`) behave differently

### Configuration

```
allow_leading_wildcard_searches = true  # Enable leading wildcards
```

## Regular Expressions

Regular expressions are enclosed in forward slashes:

```
/ethernet[0-9]+/      # Matches ethernet0, ethernet1, etc.
```

### Notes

- Uses Java regular expression syntax
- Applied to tokenized fields

## Fuzzy Searches

### Term Fuzzy Search

Uses Damerau-Levenshtein distance (default distance: 2):

```
ssh logni~            # Matches "ssh login" (default distance 2)
source:exmaple.org~   # Matches "example.org"
source:exmaple.org~1  # Distance of 1
```

### Proximity Search

Terms in a phrase can have different distances:

```
"foo bar"~5           # Terms can be up to 5 positions apart
```

## Range Queries

### Numeric Ranges

- Square brackets `[]` - Inclusive
- Curly brackets `{}` - Exclusive

```
http_response_code:[500 TO 504]    # 500, 501, 502, 503, 504
http_response_code:{400 TO 404}    # 401, 402, 403
bytes:{0 TO 64]                    # 1 to 64
http_response_code:[0 TO 64}       # 0 to 63
```

### Unbounded Ranges

```
http_response_code:>400            # Greater than 400
http_response_code:<400            # Less than 400
http_response_code:>=400           # Greater than or equal to 400
http_response_code:<=400           # Less than or equal to 400
http_response_code:(>=400 AND <500) # Combined unbounded ranges
```

### Date Ranges

Dates must be in UTC and format: `YYYY-MM-DD HH:MM:SS.sss`

```
timestamp:["2019-07-23 09:53:08.175" TO "2019-07-23 09:53:08.575"]
```

For Elasticsearch-determined date fields (ISO 8601 format):

```
otherDate:["2019-07-23T09:53:08.175" TO "2019-07-23T09:53:08.575"]
otherDate:["2020-07-29T12:00:00.000-05:00" TO "2020-07-30T15:13:00.000-05:00"]
```

### Relative Date Ranges

```
otherDate:[now-5d TO now-4d]       # From 5 days ago to 4 days ago
```

## Special Fields

### Reserved Fields

- `message` - Main message content (analyzed)
- `full_message` - Complete message (analyzed)
- `source` - Message source (analyzed)
- `timestamp` - Message timestamp
- `_id` - Message identifier
- `_exists_` - Field existence check

### Stream Filtering

```
streams:620f890b70fb980467aca611   # Filter by stream ID (MongoDB ObjectId)
```

## Escaping

Characters that must be escaped with backslash:

```
& | : \ / + - ! ( ) { } [ ] ^ " ~ * ?
```

### Example

```
resource:\/posts\/45326             # Escaped forward slashes
```

## Time Ranges

### Relative Time Ranges

Time units:
- `s` - seconds
- `m` - minutes
- `h` - hours
- `d` - days

Examples:
- `5m` - Last 5 minutes
- `1h` - Last hour
- `7d` - Last 7 days

### Absolute Time Ranges

Format: ISO 8601 or Graylog format

```json
{
  "from": "2023-04-05T09:08:23.193Z",
  "to": "2023-04-06T09:08:23.193Z",
  "type": "absolute"
}
```

### Keyword Time Ranges

Natural language time specifications:
- `"last hour"` - Previous hour
- `"last 90 days"` - Previous 90 days
- `"4 hours ago"` - From 4 hours ago to now
- `"yesterday midnight +0200 to today midnight +0200"` - Timezone-aware range

## Aggregations

### Grouping

Group messages by fields:

```
group_by: ["http_method", "http_response_code"]
```

### Metrics

Available functions:
- `avg` - Average
- `count` - Count
- `latest` - Most recent value
- `max` - Maximum
- `min` - Minimum
- `percentile` - Percentile (configurable)
- `stdDev` - Standard deviation
- `sum` - Sum
- `sumOfSquares` - Sum of squares
- `variance` - Variance

Format: `function:field_name`

Examples:
```
avg:took_ms
count
min:response_time
percentile:took_ms
```

## Grammar Definition

### EBNF Grammar

```ebnf
query           ::= expression
expression      ::= or_expression
or_expression   ::= and_expression ( "OR" and_expression )*
and_expression  ::= not_expression ( "AND" not_expression )*
not_expression  ::= "NOT"? primary_expression
primary_expression ::= "(" expression ")"
                    | field_expression
                    | term_expression
                    | phrase_expression
                    | regex_expression
                    | range_expression
                    | existence_expression

field_expression ::= field_name ":" ( term | phrase | group | range )
field_name      ::= identifier | "_exists_"
group           ::= "(" expression ")"

term_expression ::= term fuzzy_modifier?
term            ::= ( letter | digit | special_char )+
phrase_expression ::= '"' ( any_char_except_quote )* '"' proximity_modifier?
phrase          ::= '"' ( any_char_except_quote )* '"'

regex_expression ::= "/" ( any_char_except_slash )+ "/"

range_expression ::= field_name ":" ( bounded_range | unbounded_range )
bounded_range   ::= ( "[" | "{" ) range_value "TO" range_value ( "]" | "}" )
unbounded_range ::= comparison_op numeric_value
                  | "(" comparison_op numeric_value "AND" comparison_op numeric_value ")"
comparison_op   ::= ">" | "<" | ">=" | "<="
range_value     ::= numeric_value | date_value | "now" relative_time?
numeric_value   ::= digit+
date_value      ::= '"' date_string '"'
relative_time   ::= ( "+" | "-" ) digit+ time_unit
time_unit       ::= "s" | "m" | "h" | "d"

existence_expression ::= "_exists_:" field_name
                       | "NOT" "_exists_:" field_name

fuzzy_modifier  ::= "~" digit?
proximity_modifier ::= "~" digit+

wildcard        ::= "*" | "?"
identifier      ::= letter ( letter | digit | "_" )*
letter          ::= [a-zA-Z]
digit           ::= [0-9]
special_char    ::= [._-]
```

### Operator Precedence

1. Field operators (`:`)
2. Fuzzy/proximity modifiers (`~`)
3. Parentheses
4. NOT
5. AND
6. OR (implicit or explicit)

### Tokenization Rules

1. Terms are split on whitespace unless quoted
2. Default operator between terms is OR
3. Field names are case-sensitive
4. Boolean operators must be uppercase
5. Regular expressions are not tokenized

## API Endpoints

### Search Messages

```
GET /api/search/messages
POST /api/search/messages
```

Parameters:
- `query` - Search query
- `streams` - Array of stream IDs
- `fields` - Fields to return
- `from` - Offset
- `size` - Limit
- `timerange` - Time range specification
- `sort` - Sort field
- `sort_order` - asc/desc

### Aggregations

```
GET /api/search/aggregate
POST /api/search/aggregate
```

Parameters:
- `query` - Search query
- `streams` - Array of stream IDs
- `timerange` - Time range specification
- `group_by` - Grouping fields
- `metrics` - Metric functions

## Error Handling

### Error Types

1. **Parse Exception** - Syntax errors in query
2. **Invalid Operator** - Misspelled operators (e.g., `and` instead of `AND`)
3. **Unknown Field** - Field doesn't exist in index set
4. **Parameter Error** - Undeclared parameter in search query

### Validation Rules

1. Maximum query length: 10,000 characters
2. Boolean operators must be uppercase
3. Escaped characters must use backslash
4. Date formats must match expected patterns
5. Numeric ranges must have valid bounds

## Implementation Notes

### Default Behavior

- All fields searched if no field specified
- OR is default operator between terms
- Case-insensitive term matching (unless in quotes)
- Wildcards not allowed as first character (configurable)

### Performance Considerations

- Leading wildcards are expensive
- Regular expressions can impact performance
- Large proximity values increase memory usage
- Fuzzy searches with high distance values are costly

### Security Considerations

- Query length limits prevent DoS
- Regular expression complexity limits
- Field access controlled by user permissions
- Stream filtering enforces access control