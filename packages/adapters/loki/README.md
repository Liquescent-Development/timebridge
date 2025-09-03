# Loki Adapter for TimeCore

A comprehensive Loki adapter with built-in LogQL parser for the TimeCore log correlation system.

## Features

- ✅ **Full LogQL Parser**: Complete query validation and syntax checking
- ✅ **WebSocket Support**: Real-time log streaming capabilities
- ✅ **Polling Mode**: Alternative to WebSocket for restricted environments
- ✅ **SOCKS Proxy Support**: Connect through SOCKS4/SOCKS5 proxies
- ✅ **Authentication**: Bearer token and custom headers support
- ✅ **Error Recovery**: Automatic reconnection and retry logic

## Installation

```bash
npm install @timebridge/loki
```

## Usage

### Basic Setup

```javascript
const { LokiAdapter } = require('@timebridge/loki');

const adapter = new LokiAdapter({
  url: 'http://localhost:3100',
  websocket: true,  // Enable WebSocket streaming
  authToken: 'your-auth-token',
  headers: {
    'X-Scope-OrgID': 'tenant-1'
  }
});

// Query logs
const stream = adapter.query(
  '{job="nginx"} |= "error"',
  new Date(Date.now() - 3600000), // 1 hour ago
  new Date()
);

for await (const event of stream) {
  console.log(event);
}
```

### Using the LogQL Parser

```javascript
const { LogQLParser } = require('@timebridge/loki');

const parser = new LogQLParser();

// Parse a query
const result = parser.parse('{job="nginx"} |= "error" | json | status >= 400');
if (result.valid) {
  console.log('AST:', result.ast);
} else {
  console.log('Error:', result.error);
  console.log('Suggestions:', result.suggestions);
}

// Validate a query
const validation = parser.validate('{job="nginx"} |= "error"');
if (validation.valid) {
  console.log('Query is valid!');
} else {
  console.log('Validation errors:', validation.errors);
}

// Get query type (log or metric)
const ast = result.ast;
const queryType = parser.getQueryType(ast); // 'log' or 'metric'

// Convert AST back to query string
const queryString = parser.stringify(ast);
```

## LogQL Query Examples

### Log Queries

```logql
# Simple selector
{job="nginx"}

# With line filters
{job="nginx"} |= "error" != "debug"

# With regex
{job="nginx"} |~ "\\d+\\.\\d+\\.\\d+\\.\\d+"

# With JSON parsing
{job="nginx"} | json | status >= 400

# With pattern parsing
{job="nginx"} | pattern "<ip> <method> <path> <status>"

# With label formatting
{job="nginx"} | json | line_format "{{.method}} {{.path}} - {{.status}}"
```

### Metric Queries

```logql
# Count logs over time
count_over_time({job="nginx"}[5m])

# Rate of logs
rate({job="nginx"}[5m])

# Aggregate by status
sum by (status) (rate({job="nginx"} | json [5m]))

# Unwrap and aggregate numeric values
avg_over_time({job="nginx"} | json | unwrap response_time [5m])

# Percentile calculation
quantile_over_time(0.95, {job="nginx"} | json | unwrap latency_ms [5m])
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run only parser tests
npm test -- logql-parser.test.ts

# Run with coverage
npm test -- --coverage
```

### Writing Tests

```javascript
describe('My LogQL queries', () => {
  let parser;

  beforeEach(() => {
    parser = new LogQLParser();
  });

  it('should parse my custom query', () => {
    const result = parser.parse('{app="myapp"} | json | level="error"');
    expect(result.valid).toBe(true);
    expect(result.ast.type).toBe('log');
  });
});
```

### Integration Testing

```javascript
const { LokiAdapter } = require('@timebridge/loki');

describe('Loki Integration', () => {
  let adapter;

  beforeEach(() => {
    adapter = new LokiAdapter({
      url: process.env.LOKI_URL || 'http://localhost:3100'
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('should validate queries before execution', () => {
    const valid = adapter.validateQuery('{job="test"} |= "error"');
    expect(valid).toBe(true);

    const invalid = adapter.validateQuery('{invalid query}');
    expect(invalid).toBe(false);
  });

  it('should stream logs', async () => {
    const events = [];
    const stream = adapter.query(
      '{job="test"}',
      new Date(Date.now() - 60000),
      new Date()
    );

    for await (const event of stream) {
      events.push(event);
      if (events.length >= 10) break;
    }

    expect(events.length).toBeGreaterThan(0);
  });
});
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | required | Loki server URL |
| `websocket` | boolean | `true` | Use WebSocket for streaming |
| `pollInterval` | number | `1000` | Polling interval in ms (when WebSocket disabled) |
| `timeout` | number | `30000` | Request timeout in ms |
| `maxRetries` | number | `3` | Maximum retry attempts |
| `authToken` | string | - | Bearer authentication token |
| `headers` | object | `{}` | Additional HTTP headers |
| `proxy` | object | - | SOCKS proxy configuration |

### Proxy Configuration

```javascript
{
  proxy: {
    host: '127.0.0.1',
    port: 1080,
    type: 5,  // SOCKS5 (or 4 for SOCKS4)
    username: 'user',  // optional
    password: 'pass'   // optional
  }
}
```

## Error Handling

The adapter and parser provide detailed error information:

```javascript
try {
  const stream = adapter.query('{invalid}', start, end);
  for await (const event of stream) {
    // process events
  }
} catch (error) {
  if (error.code === 'LOKI_QUERY_ERROR') {
    console.error('Query error:', error.message);
    console.error('Details:', error.details);
  }
}

// Parser errors
const result = parser.parse('{job="test" invalid syntax');
if (!result.valid) {
  console.error('Parse error:', result.error);
  // "Unclosed brace - missing '}' at line 1, column 11"
  console.log('Suggestions:', result.suggestions);
  // ["Close the label matcher with '}'"]
}
```

## Performance Considerations

1. **Use specific label matchers**: More specific queries perform better
   ```logql
   # Good
   {job="nginx", env="prod"}
   
   # Less efficient
   {job=~".*"}
   ```

2. **Limit time ranges**: Smaller time windows return faster
   ```javascript
   // Query last 5 minutes instead of last hour when possible
   adapter.query(query, new Date(Date.now() - 5*60*1000), new Date());
   ```

3. **Use streaming**: Process results as they arrive
   ```javascript
   for await (const event of stream) {
     processEvent(event);  // Process immediately
   }
   ```

## API Reference

### LokiAdapter

#### Methods

- `query(query: string, start: Date, end: Date): AsyncIterable<LogEvent>`
- `validateQuery(query: string): boolean`
- `connect(): Promise<void>`
- `disconnect(): Promise<void>`
- `getAvailableStreams(): Promise<string[]>`

### LogQLParser

#### Methods

- `parse(query: string): ParseResult`
- `validate(query: string): ValidationResult`
- `stringify(ast: LogQLAST): string`
- `getQueryType(ast: LogQLAST): 'log' | 'metric'`

## Troubleshooting

### WebSocket Connection Issues

If WebSocket connections fail, try:

1. Disable WebSocket and use polling:
   ```javascript
   const adapter = new LokiAdapter({
     url: 'http://localhost:3100',
     websocket: false,
     pollInterval: 2000
   });
   ```

2. Check firewall/proxy settings
3. Verify Loki supports WebSocket at `/loki/api/v1/tail`

### Query Validation Errors

Use the parser to debug queries:

```javascript
const result = parser.validate(yourQuery);
if (!result.valid) {
  result.errors.forEach(error => {
    console.log(`${error.type}: ${error.message}`);
    if (error.suggestion) {
      console.log(`  Suggestion: ${error.suggestion}`);
    }
  });
}
```

## Contributing

See the main [TimeCore Contributing Guide](../../../CONTRIBUTING.md).

## License

AGPL-3.0