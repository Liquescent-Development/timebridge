# Testing TimeBridge with TimeQL

This guide shows how to use TimeBridge's TimeQL query language and executor for unified time-series correlation.

## Quick Start with TimeQL Executor

### Step 1: Build the packages
```bash
cd /workspace
npm run build
```

### Step 2: Create npm links
```bash
# Link core package
cd packages/core
npm link

# Link adapters
cd ../adapters/loki
npm link
cd ../prometheus  
npm link
cd ../influxdb
npm link
cd ../graylog
npm link
```

### Step 3: Link in your test application
```bash
cd /path/to/your/test/app
npm link @timebridge/core
npm link @timebridge/loki
npm link @timebridge/prometheus
npm link @timebridge/influxdb
npm link @timebridge/graylog
```

## Option 2: Local NPM Registry (Verdaccio)

### Install and run Verdaccio
```bash
npm install -g verdaccio
verdaccio
```

### Publish to local registry
```bash
cd /workspace
npm set registry http://localhost:4873/
npm run publish:all
```

### In your test app
```bash
npm set registry http://localhost:4873/
npm install @timebridge/core @timebridge/loki
```

## Option 3: NPM Pre-release Version

### Bump version to pre-release
```bash
cd /workspace
# This would bump to 0.0.8-alpha.0
npm version prerelease --workspaces --preid=alpha
```

### Publish with alpha tag
```bash
npm publish --tag alpha --workspaces --access public
```

### Install in test app
```bash
npm install @timebridge/core@alpha @timebridge/loki@alpha
```

## Option 4: Direct File Reference

### In your test app's package.json
```json
{
  "dependencies": {
    "@timebridge/core": "file:../workspace/packages/core",
    "@timebridge/loki": "file:../workspace/packages/adapters/loki"
  }
}
```

## Option 5: Git Repository Reference

### In your test app's package.json
```json
{
  "dependencies": {
    "@timebridge/core": "git+https://github.com/Liquescent-Development/timebridge.git#feat/timebridge-rename"
  }
}
```

## Sample Test Application Using TimeQL

Create a test application that uses the TimeQL executor:

```javascript
// test-timeql.js
const { TimeQLExecutor } = require('@timebridge/core');
const { LokiAdapter } = require('@timebridge/loki');
const { PrometheusAdapter } = require('@timebridge/prometheus');
const { GraylogAdapter } = require('@timebridge/graylog');
const { InfluxDBAdapter } = require('@timebridge/influxdb');

async function testTimeQL() {
  // Initialize the TimeQL executor
  const executor = new TimeQLExecutor({
    timeWindow: 300000, // 5 minutes
    maxEvents: 100000,
    streaming: true
  });

  // Register adapters with the executor
  // You can register multiple instances of the same type with different names
  executor.addAdapter('loki', new LokiAdapter({
    url: 'http://localhost:3000', // Can be Grafana or direct Loki
    authToken: 'your-token',
    datasourceName: 'Loki' // For Grafana proxy
  }));

  executor.addAdapter('prometheus', new PrometheusAdapter({
    url: 'http://localhost:3000', // Can be Grafana or direct Prometheus
    authToken: 'your-token',
    datasourceName: 'Prometheus'
  }));

  executor.addAdapter('graylog', new GraylogAdapter({
    url: 'http://localhost:9000',
    apiToken: 'your-api-token',
    // The adapter automatically extracts all Graylog fields as labels
    // Compatible with both message.fields and direct field structures
  }));

  executor.addAdapter('influxdb', new InfluxDBAdapter({
    url: 'http://localhost:8086',
    database: 'metrics',
    version: '1.x'
  }));

  // Example 1: Direct query (single data source)
  console.log('📊 Direct Query Example:');
  const directQuery = 'loki({service="api", level="error"})[5m]';
  
  for await (const event of executor.execute(directQuery)) {
    console.log('Log event:', {
      timestamp: event.timestamp,
      message: event.message,
      labels: event.labels,  // All Graylog fields extracted here
      joinKeys: event.joinKeys  // Correlation fields like request_id, trace_id
    });
  }

  // Example 2: Correlation query (multiple data sources)
  console.log('\n🔗 Correlation Query Example:');
  const correlationQuery = `
    loki({service="frontend"})[5m]
      and on(request_id)
    loki({service="backend"})[5m]
      and on(request_id)
    graylog(service:api AND level:ERROR)[5m]
  `;

  for await (const correlation of executor.execute(correlationQuery)) {
    console.log('Correlated events:', {
      correlationId: correlation.correlationId,
      joinKey: correlation.joinKey,
      joinValue: correlation.joinValue,
      eventCount: correlation.events.length,
      sources: [...new Set(correlation.events.map(e => e.source))]
    });
    
    // Show how Graylog fields enable correlation
    correlation.events.forEach(event => {
      if (event.source === 'graylog') {
        console.log('  Graylog event labels:', event.labels);
        console.log('  Available join keys:', Object.keys(event.joinKeys));
      }
    });
  }

  // Example 3: Complex time-windowed correlation
  console.log('\n⏱️ Time-Windowed Correlation:');
  const timeWindowQuery = `
    prometheus(rate(http_requests_total{status="500"}[1m]))[10m]
      and on(service) within(30s)
    influxdb(SELECT * FROM errors WHERE severity = 'critical')[10m]
      and on(service)
    loki({level="error"})[10m]
  `;

  for await (const result of executor.execute(timeWindowQuery)) {
    console.log('Time-correlated result:', result);
  }

  // Example 4: Query validation
  console.log('\n✅ Query Validation:');
  const validation = executor.validateQuery(correlationQuery);
  console.log('Query validation:', {
    valid: validation.valid,
    type: validation.type,
    sources: validation.sources
  });
}

// Using the convenience function for simple cases
async function testSimpleQuery() {
  const { query } = require('@timebridge/core');
  
  const adapters = {
    loki: new LokiAdapter({ url: 'http://localhost:3100' }),
    prometheus: new PrometheusAdapter({ url: 'http://localhost:9090' })
  };

  const timeQLQuery = `
    loki({job="app"})[5m]
      and on(instance)
    prometheus(up{job="app"})[5m]
  `;

  for await (const event of query(timeQLQuery, adapters)) {
    console.log(event);
  }
}

testTimeQL().catch(console.error);
```

## Graylog Field Extraction Examples

The Graylog adapter automatically extracts all custom fields as labels, making them available for correlation and filtering. This works with different Graylog response structures:

### Example: Universal Field Extraction

```javascript
// test-graylog-fields.js
const { TimeQLExecutor } = require('@timebridge/core');
const { GraylogAdapter } = require('@timebridge/graylog');

async function testGraylogFieldExtraction() {
  const executor = new TimeQLExecutor();
  
  executor.addAdapter('graylog', new GraylogAdapter({
    url: 'http://localhost:9000',
    apiToken: 'your-api-token',
    // Adapter handles both field structures automatically
  }));

  console.log('Testing Graylog field extraction...');
  
  // Query that will return events with various fields
  const fieldQuery = 'graylog(level:info)[5m]';
  let count = 0;
  
  for await (const event of executor.execute(fieldQuery)) {
    console.log('\n📋 Event Field Analysis:');
    console.log('Message:', event.message);
    console.log('Available labels:', event.labels);
    console.log('Join keys for correlation:', event.joinKeys);
    
    // Show which fields can be used for correlation
    const correlationFields = Object.keys(event.joinKeys);
    if (correlationFields.length > 0) {
      console.log('✅ Can correlate on:', correlationFields.join(', '));
    } else {
      console.log('❌ No correlation fields detected');
      console.log('   Available labels for manual correlation:', Object.keys(event.labels).join(', '));
    }
    
    // Break after first few events for demo
    if (++count >= 3) break;
  }
}

testGraylogFieldExtraction().catch(console.error);
```

### Example: Multi-Service Correlation Using Extracted Fields

```javascript
// test-correlation-fields.js
const { TimeQLExecutor } = require('@timebridge/core');
const { GraylogAdapter } = require('@timebridge/graylog');

async function testGraylogCorrelation() {
  const executor = new TimeQLExecutor();
  
  // Register multiple Graylog instances (e.g., different environments)
  executor.addAdapter('graylog-app', new GraylogAdapter({
    url: 'http://app-graylog:9000',
    apiToken: 'app-token',
    streamName: 'Application Logs'
  }));
  
  executor.addAdapter('graylog-db', new GraylogAdapter({
    url: 'http://db-graylog:9000', 
    apiToken: 'db-token',
    streamName: 'Database Logs'
  }));

  // Correlate application events with database events using extracted fields
  const correlationQuery = `
    graylog-app(service:frontend AND request_id:*)[10m]
      and on(request_id)
    graylog-db(query_type:SELECT)[10m]
  `;

  console.log('🔗 Correlating across Graylog instances using extracted fields...');
  
  for await (const correlation of executor.execute(correlationQuery)) {
    console.log(`\n📊 Correlation found: ${correlation.joinValue}`);
    
    correlation.events.forEach(event => {
      console.log(`  [${event.source}] ${event.message}`);
      
      // Show relevant extracted fields for each event
      if (event.source === 'graylog') {
        const relevantFields = ['service', 'level', 'user_id', 'response_time', 'query_type'];
        const extracted = {};
        relevantFields.forEach(field => {
          if (event.labels[field]) {
            extracted[field] = event.labels[field];
          }
        });
        console.log('    Extracted fields:', extracted);
      }
    });
  }
}

testGraylogCorrelation().catch(console.error);
```

## TimeQL Query Language

TimeQL is a PromQL-inspired query language for correlating time-series data across multiple sources:

### Basic Syntax
```
source(selector)[timeRange]
```

### Correlation Operators
- `and on(field)` - Inner join on specified field
- `or on(field)` - Left join on specified field  
- `unless on(field)` - Anti-join on specified field
- `within(duration)` - Time window constraint
- `align on(timestamp)` - Timestamp alignment

### Example Queries

```javascript
// Single source query
'loki({service="api"})[5m]'

// Two-source correlation
'loki({service="frontend"})[5m] and on(request_id) loki({service="backend"})[5m]'

// Multi-source correlation with time window
'prometheus(up)[10m] and on(job) within(30s) loki({job=~".*"})[10m]'

// Complex correlation across 3+ sources
'graylog(service:api)[1h] and on(request_id) loki({service="api"})[1h] and on(request_id) prometheus(http_requests_total)[1h]'
```

## Advanced TimeQL Features

### Named Adapter Instances
Register multiple instances of the same adapter type with different configurations:

```javascript
const executor = new TimeQLExecutor();

// Register multiple Graylog instances
executor.addAdapter('graylog-prod', new GraylogAdapter({
  url: 'http://graylog-prod:9000',
  apiToken: 'prod-token'
}), { isDefault: true });

executor.addAdapter('graylog-staging', new GraylogAdapter({
  url: 'http://graylog-staging:9000',
  apiToken: 'staging-token'
}));

// Use specific instances in queries
const query = `
  graylog-prod(service:api)[5m]
    and on(request_id)
  graylog-staging(service:api)[5m]
`;
```

### Streaming Results
Process results as they arrive for real-time monitoring:

```javascript
async function streamResults() {
  const executor = new TimeQLExecutor({ streaming: true });
  
  // Add your adapters...
  
  const query = 'loki({service="api"})[5m]';
  
  for await (const event of executor.execute(query)) {
    // Process each event as it arrives
    console.log(`[${event.timestamp}] ${event.message}`);
    
    // You can break early if needed
    if (someCondition) break;
  }
}
```

### Error Handling and Validation

```javascript
// Always validate queries before execution
const validation = executor.validateQuery(query);
if (!validation.valid) {
  console.error('Query error:', validation.error);
  return;
}

// Handle execution errors
try {
  for await (const result of executor.execute(query)) {
    processResult(result);
  }
} catch (error) {
  console.error('Execution error:', error);
}
```

## Testing with Docker Compose

Create a complete test environment with all supported data sources:

```yaml
version: '3'
services:
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_SECURITY_ADMIN_USER=admin
    volumes:
      - grafana-storage:/var/lib/grafana

  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  influxdb:
    image: influxdb:1.8
    ports:
      - "8086:8086"
    environment:
      - INFLUXDB_DB=metrics
      - INFLUXDB_ADMIN_USER=admin
      - INFLUXDB_ADMIN_PASSWORD=admin

  graylog:
    image: graylog/graylog:5.0
    ports:
      - "9000:9000"
      - "12201:12201/udp"
    environment:
      - GRAYLOG_PASSWORD_SECRET=somepasswordpepper
      - GRAYLOG_ROOT_PASSWORD_SHA2=8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918
    depends_on:
      - mongodb
      - elasticsearch

  mongodb:
    image: mongo:5.0

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch-oss:7.10.2
    environment:
      - discovery.type=single-node

volumes:
  grafana-storage:
```

## Performance Considerations

### Memory Management
```javascript
const executor = new TimeQLExecutor({
  maxEvents: 50000,        // Limit total events in memory
  timeWindow: 60000,       // 1-minute correlation window
  bufferSize: 10000,       // Per-stream buffer size
  enableBackpressure: true // Auto-throttle when buffers fill
});
```

### Query Optimization Tips
1. Use specific time ranges to limit data volume
2. Add field selectors to filter early in the pipeline
3. Use `within()` for time-scoped correlations
4. Consider streaming mode for large result sets

## Troubleshooting

### Common Issues

1. **No correlations found**
   - Check that join keys exist in both data sources
   - Verify time ranges overlap
   - Use `within()` for looser time matching

2. **Memory errors**
   - Reduce time range
   - Lower `maxEvents` limit
   - Enable streaming mode

3. **Slow queries**
   - Add more specific selectors
   - Use indexed fields for joins
   - Consider parallel processing

### Debug Mode
```javascript
const executor = new TimeQLExecutor({
  debug: true,
  onDebug: (msg) => console.log('[DEBUG]', msg)
});
```