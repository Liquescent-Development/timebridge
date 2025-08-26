# @liquescent/log-correlator-query-parser

PromQL-inspired query parser for log correlation with full support for native Graylog and Loki query syntax.

## Features

- **PromQL-style correlation syntax** for joining log streams
- **Native Graylog query support** including boolean operators, wildcards, ranges, and special operators
- **Loki LogQL compatibility** for label-based queries
- **Temporal correlation** with time window constraints
- **Flexible join types** (inner, left, anti-join)
- **Parse-time validation** to catch syntax errors early

## Installation

```bash
npm install @liquescent/log-correlator-query-parser
```

## Usage

```javascript
const { PeggyQueryParser } = require("@liquescent/log-correlator-query-parser");

const parser = new PeggyQueryParser();

// Parse a correlation query
const query =
  'graylog(tier:prd AND status:500)[10m] and on(request_id) loki({service="api"})[10m]';
const parsed = parser.parse(query);

// Validate syntax
const validation = parser.validate(query);
if (!validation.valid) {
  console.error("Query error:", validation.error);
}
```

## Query Syntax

### Basic Structure

```
SOURCE(SELECTOR)[TIME_RANGE] JOIN_OPERATOR SOURCE(SELECTOR)[TIME_RANGE]
```

### Supported Sources

- `graylog` - Graylog log source with native query syntax
- `loki` - Loki/Grafana log source with LogQL syntax

### Examples

#### Graylog Correlation

```
graylog(tier:prd AND http-status-code:5*)[1h]
  and on(request_id)
graylog(tier:staging)[1h]
```

#### Loki Correlation

```
loki({service="frontend", level="error"})[30m]
  and on(trace_id)
loki({service="backend"})[30m]
```

#### Cross-System Correlation

```
graylog(_exists_:request-id)[10m]
  and on(request_id=request-id)
loki({job="nginx"})[10m]
```

## Full Documentation

- [Graylog Query Syntax](./GRAYLOG_SYNTAX.md) - Complete guide to supported Graylog syntax
- [API Reference](./API.md) - Detailed API documentation

## Development

```bash
# Generate parser from grammar
npm run generate-parser

# Build TypeScript
npm run build

# Run tests
npm test
```

## Grammar

The parser is built using [Peggy](https://peggyjs.org/) with the grammar defined in `grammar/logql.peggy`.

## License

AGPL-3.0
