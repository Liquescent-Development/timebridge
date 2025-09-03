/**
 * Grafana Data Source Integration Examples
 * 
 * This example demonstrates how to use TimeCore adapters with Grafana data sources.
 * The adapters automatically detect Grafana and transparently handle the connection.
 */

const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');
const { LokiAdapter } = require('@timebridge/adapter-loki');
const { InfluxDBAdapter } = require('@timebridge/adapter-influxdb');

// Configuration - can be environment variables
const GRAFANA_URL = process.env.GRAFANA_URL || 'https://grafana.example.com';
const GRAFANA_TOKEN = process.env.GRAFANA_TOKEN || 'glsa_xxxxxxxxxxxx';

/**
 * Example 1: Basic Prometheus Query through Grafana
 */
async function prometheusExample() {
  console.log('\n=== Prometheus Example ===');
  
  const adapter = new PrometheusAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN,
    datasourceName: 'Prometheus Production' // Optional - uses default if not specified
  });
  
  // Execute a PromQL query - works exactly like direct connection
  const query = 'sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)';
  console.log(`Executing query: ${query}`);
  
  try {
    const events = [];
    for await (const event of adapter.query(query)) {
      events.push(event);
      console.log(`Pod: ${event.labels.pod}, CPU Rate: ${event.labels.__value__}`);
      
      // Limit output for demo
      if (events.length >= 5) break;
    }
    console.log(`Received ${events.length} metrics`);
  } catch (error) {
    console.error('Query failed:', error.message);
  }
}

/**
 * Example 2: Loki Log Streaming through Grafana
 */
async function lokiExample() {
  console.log('\n=== Loki Example ===');
  
  const adapter = new LokiAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN,
    datasourceName: 'Loki Logs'
  });
  
  // LogQL query for error logs
  const query = '{service="nginx"} |= "error" | json | line_format "{{.timestamp}} {{.level}}: {{.message}}"';
  console.log(`Executing query: ${query}`);
  
  try {
    const events = [];
    for await (const event of adapter.query(query, { limit: 10 })) {
      events.push(event);
      console.log(`[${event.timestamp}] ${event.message}`);
    }
    console.log(`Received ${events.length} log entries`);
  } catch (error) {
    console.error('Query failed:', error.message);
  }
}

/**
 * Example 3: InfluxDB Time Series through Grafana
 */
async function influxExample() {
  console.log('\n=== InfluxDB Example ===');
  
  const adapter = new InfluxDBAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN,
    datasourceName: 'InfluxDB Metrics'
  });
  
  // InfluxQL query for CPU metrics
  const query = 'SELECT mean("usage_idle") FROM "cpu" WHERE time > now() - 1h GROUP BY time(5m), "host"';
  console.log(`Executing query: ${query}`);
  
  try {
    const events = [];
    for await (const event of adapter.query(query)) {
      events.push(event);
      console.log(`Time: ${event.timestamp}, Host: ${event.tags.host}, CPU Idle: ${event.fields.mean}%`);
      
      // Limit output for demo
      if (events.length >= 5) break;
    }
    console.log(`Received ${events.length} data points`);
  } catch (error) {
    console.error('Query failed:', error.message);
  }
}

/**
 * Example 4: Auto-detection - Works with both Direct and Grafana
 */
async function autoDetectionExample() {
  console.log('\n=== Auto-Detection Example ===');
  
  // This URL could be either Grafana or direct Prometheus
  const url = process.env.METRICS_URL || GRAFANA_URL;
  
  const adapter = new PrometheusAdapter({
    url: url,
    authToken: process.env.METRICS_TOKEN || GRAFANA_TOKEN,
    datasourceName: 'Prometheus' // Ignored if connecting directly
  });
  
  console.log(`Connecting to: ${url}`);
  console.log(`Detection result: ${adapter.isGrafana() ? 'Grafana' : 'Direct'} connection`);
  
  // Query works the same regardless of connection type
  try {
    const query = 'up{job="prometheus"}';
    const events = [];
    
    for await (const event of adapter.query(query)) {
      events.push(event);
      console.log(`Instance: ${event.labels.instance}, Status: ${event.labels.__value__}`);
      
      // Limit output
      if (events.length >= 3) break;
    }
  } catch (error) {
    console.error('Query failed:', error.message);
  }
}

/**
 * Example 5: Query Validation with Parser
 */
async function parserExample() {
  console.log('\n=== Parser Integration Example ===');
  
  const adapter = new PrometheusAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN
  });
  
  const queries = [
    'rate(http_requests_total[5m])',  // Valid
    'sum by (invalid syntax',           // Invalid
    'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))'  // Valid
  ];
  
  for (const query of queries) {
    console.log(`\nValidating: ${query}`);
    const result = adapter.parseQuery(query);
    
    if (result.isValid) {
      console.log('✅ Valid query');
      console.log('AST:', JSON.stringify(result.ast, null, 2).substring(0, 100) + '...');
    } else {
      console.log('❌ Invalid query');
      console.log('Errors:', result.errors);
    }
  }
}

/**
 * Example 6: Advanced Configuration with Proxy
 */
async function proxyExample() {
  console.log('\n=== Proxy Configuration Example ===');
  
  const adapter = new PrometheusAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN,
    datasourceName: 'Prometheus Production',
    
    // SOCKS proxy configuration
    proxy: {
      host: process.env.PROXY_HOST || 'socks5://proxy.example.com',
      port: parseInt(process.env.PROXY_PORT || '1080'),
      auth: {
        username: process.env.PROXY_USER,
        password: process.env.PROXY_PASS
      }
    },
    
    // Grafana-specific options
    grafanaOptions: {
      refreshDataSources: true,      // Force refresh data source cache
      datasourceCacheTTL: 3600000,   // 1 hour cache
      maxRetries: 3,                 // Retry failed requests
      timeout: 30000                 // 30 second timeout
    }
  });
  
  console.log('Configured with proxy and custom options');
  
  try {
    const query = 'up';
    for await (const event of adapter.query(query)) {
      console.log(`Metric received through proxy: ${event.labels.__name__}`);
      break; // Just show it works
    }
  } catch (error) {
    console.error('Query failed:', error.message);
  }
}

/**
 * Example 7: Multiple Data Sources
 */
async function multiDataSourceExample() {
  console.log('\n=== Multiple Data Sources Example ===');
  
  // Create adapters for different environments
  const production = new PrometheusAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN,
    datasourceName: 'Prometheus Production'
  });
  
  const staging = new PrometheusAdapter({
    url: GRAFANA_URL,
    authToken: GRAFANA_TOKEN,
    datasourceName: 'Prometheus Staging'
  });
  
  // Query both environments
  const query = 'up{job="api"}';
  
  console.log('Querying Production...');
  let count = 0;
  for await (const event of production.query(query)) {
    count++;
  }
  console.log(`Production instances: ${count}`);
  
  console.log('Querying Staging...');
  count = 0;
  for await (const event of staging.query(query)) {
    count++;
  }
  console.log(`Staging instances: ${count}`);
}

/**
 * Example 8: Error Handling
 */
async function errorHandlingExample() {
  console.log('\n=== Error Handling Example ===');
  
  // Test various error conditions
  const scenarios = [
    {
      name: 'Invalid data source name',
      config: {
        url: GRAFANA_URL,
        authToken: GRAFANA_TOKEN,
        datasourceName: 'Non-existent Data Source'
      }
    },
    {
      name: 'Invalid authentication',
      config: {
        url: GRAFANA_URL,
        authToken: 'invalid-token'
      }
    },
    {
      name: 'Invalid query syntax',
      config: {
        url: GRAFANA_URL,
        authToken: GRAFANA_TOKEN
      },
      query: 'invalid query syntax {'
    }
  ];
  
  for (const scenario of scenarios) {
    console.log(`\nTesting: ${scenario.name}`);
    try {
      const adapter = new PrometheusAdapter(scenario.config);
      const query = scenario.query || 'up';
      
      for await (const event of adapter.query(query)) {
        console.log('Unexpected success!');
        break;
      }
    } catch (error) {
      console.log(`Expected error: ${error.message}`);
    }
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('TimeCore Grafana Integration Examples');
  console.log('=====================================');
  
  // Check if running against real Grafana
  if (GRAFANA_URL === 'https://grafana.example.com') {
    console.log('\n⚠️  Note: Using example URL. Set GRAFANA_URL and GRAFANA_TOKEN environment variables for real testing.\n');
  }
  
  try {
    // Run examples
    await prometheusExample();
    await lokiExample();
    await influxExample();
    await autoDetectionExample();
    await parserExample();
    await proxyExample();
    await multiDataSourceExample();
    await errorHandlingExample();
    
    console.log('\n✅ All examples completed');
  } catch (error) {
    console.error('\n❌ Example failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

// Export for use in other scripts
module.exports = {
  prometheusExample,
  lokiExample,
  influxExample,
  autoDetectionExample,
  parserExample,
  proxyExample,
  multiDataSourceExample,
  errorHandlingExample
};