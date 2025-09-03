/**
 * Grafana Performance Optimization Examples
 * 
 * Demonstrates how to use advanced performance features with Grafana data sources.
 */

const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');
const { LokiAdapter } = require('@timebridge/adapter-loki');

/**
 * Example 1: Basic optimization with default settings
 */
async function basicOptimization() {
  console.log('\n=== Basic Optimization ===');
  
  const adapter = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    
    // Enable all optimizations with defaults
    optimization: {
      connectionPool: true,    // Connection pooling enabled
      queryBatching: true,     // Query batching enabled
      caching: true,           // Response caching enabled
      compression: true,       // Gzip compression enabled
      streamOptimization: true // Stream buffering enabled
    }
  });
  
  // Multiple queries will be batched automatically
  const promises = [
    adapter.query('up{job="api"}'),
    adapter.query('up{job="frontend"}'),
    adapter.query('up{job="backend"}')
  ];
  
  // Queries are batched and executed efficiently
  for (const promise of promises) {
    for await (const event of await promise) {
      console.log(`Metric: ${event.labels.__name__}, Value: ${event.labels.__value__}`);
      break; // Just show first result
    }
  }
  
  // Check performance stats
  const stats = adapter.getPerformanceStats();
  console.log('Performance Stats:', JSON.stringify(stats, null, 2));
}

/**
 * Example 2: Custom connection pooling
 */
async function customConnectionPool() {
  console.log('\n=== Custom Connection Pool ===');
  
  const adapter = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    
    optimization: {
      connectionPool: {
        maxConnections: 100,         // Total connection limit
        maxConnectionsPerHost: 20,   // Per-host limit
        keepAlive: true,
        keepAliveMsecs: 5000,
        timeout: 60000,              // 60 second timeout
        maxFreeSockets: 20,
        scheduling: 'lifo'           // Last-in-first-out
      }
    }
  });
  
  // Execute many concurrent queries
  const queries = [];
  for (let i = 0; i < 50; i++) {
    queries.push(adapter.query(`up{instance=~"server${i}.*"}`));
  }
  
  console.log(`Executing ${queries.length} concurrent queries...`);
  const results = await Promise.all(queries.map(async (q) => {
    const events = [];
    for await (const event of q) {
      events.push(event);
    }
    return events.length;
  }));
  
  console.log(`Completed. Total events: ${results.reduce((a, b) => a + b, 0)}`);
  
  const poolStats = adapter.getPerformanceStats().connectionPool;
  console.log('Connection Pool Stats:', poolStats);
}

/**
 * Example 3: Advanced caching strategies
 */
async function advancedCaching() {
  console.log('\n=== Advanced Caching ===');
  
  const adapter = new LokiAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    
    optimization: {
      caching: {
        maxSize: 100 * 1024 * 1024,  // 100MB cache
        ttl: 600000                  // 10 minute TTL
      }
    }
  });
  
  const query = '{service="nginx"} |= "error"';
  
  // First query - cache miss
  console.log('First query (cache miss)...');
  let startTime = Date.now();
  let count = 0;
  for await (const event of adapter.query(query)) {
    count++;
  }
  let elapsed = Date.now() - startTime;
  console.log(`Retrieved ${count} events in ${elapsed}ms`);
  
  // Second query - cache hit
  console.log('Second query (cache hit)...');
  startTime = Date.now();
  count = 0;
  for await (const event of adapter.query(query)) {
    count++;
  }
  elapsed = Date.now() - startTime;
  console.log(`Retrieved ${count} events in ${elapsed}ms (from cache)`);
  
  // Get cache statistics
  const cacheStats = adapter.getPerformanceStats().cache;
  console.log('Cache Stats:', cacheStats);
  
  // Invalidate specific cache entries
  const invalidated = adapter.invalidateCache(/nginx/);
  console.log(`Invalidated ${invalidated} cache entries`);
}

/**
 * Example 4: Query batching with custom settings
 */
async function queryBatching() {
  console.log('\n=== Query Batching ===');
  
  const adapter = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    
    optimization: {
      queryBatching: {
        maxBatchSize: 20,      // Batch up to 20 queries
        batchTimeout: 200,     // Wait up to 200ms
        maxConcurrent: 5       // Max 5 concurrent batches
      }
    }
  });
  
  // Generate many queries that will be batched
  const queries = [];
  for (let i = 0; i < 100; i++) {
    queries.push(
      adapter.query(`rate(http_requests_total{job="api",instance="${i}"}[5m])`)
    );
  }
  
  console.log('Executing 100 queries with batching...');
  const startTime = Date.now();
  
  const results = await Promise.all(queries.map(async (q) => {
    let count = 0;
    for await (const event of q) {
      count++;
    }
    return count;
  }));
  
  const elapsed = Date.now() - startTime;
  console.log(`Completed in ${elapsed}ms`);
  
  const batchStats = adapter.getPerformanceStats().queryBatcher;
  console.log('Batch Stats:', batchStats);
  console.log(`Average batch size: ${batchStats.averageBatchSize.toFixed(1)}`);
}

/**
 * Example 5: Stream optimization
 */
async function streamOptimization() {
  console.log('\n=== Stream Optimization ===');
  
  const adapter = new LokiAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    
    optimization: {
      streamOptimization: true,
      compression: true
    }
  });
  
  // Query that returns many results
  const query = '{service="api"} | json | status >= 400';
  
  console.log('Processing large result set with stream optimization...');
  let count = 0;
  let bytes = 0;
  
  for await (const event of adapter.query(query, { limit: 10000 })) {
    count++;
    bytes += JSON.stringify(event).length;
    
    // Show progress
    if (count % 1000 === 0) {
      console.log(`Processed ${count} events (${(bytes / 1024).toFixed(1)}KB)`);
    }
  }
  
  console.log(`Total: ${count} events, ${(bytes / 1024).toFixed(1)}KB processed`);
}

/**
 * Example 6: Compression benefits
 */
async function compressionBenefits() {
  console.log('\n=== Compression Benefits ===');
  
  // Without compression
  const uncompressed = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    optimization: {
      compression: false
    }
  });
  
  // With compression
  const compressed = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    optimization: {
      compression: true
    }
  });
  
  const query = 'rate(http_requests_total[5m])';
  
  console.log('Testing without compression...');
  let startTime = Date.now();
  let count = 0;
  for await (const event of uncompressed.query(query)) {
    count++;
  }
  const uncompressedTime = Date.now() - startTime;
  console.log(`Uncompressed: ${count} events in ${uncompressedTime}ms`);
  
  console.log('Testing with compression...');
  startTime = Date.now();
  count = 0;
  for await (const event of compressed.query(query)) {
    count++;
  }
  const compressedTime = Date.now() - startTime;
  console.log(`Compressed: ${count} events in ${compressedTime}ms`);
  
  const improvement = ((uncompressedTime - compressedTime) / uncompressedTime * 100).toFixed(1);
  console.log(`Performance improvement: ${improvement}%`);
}

/**
 * Example 7: Full optimization stack
 */
async function fullOptimization() {
  console.log('\n=== Full Optimization Stack ===');
  
  const adapter = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: process.env.GRAFANA_TOKEN,
    
    // Enable everything with custom settings
    optimization: {
      connectionPool: {
        maxConnections: 200,
        maxConnectionsPerHost: 50
      },
      queryBatching: {
        maxBatchSize: 25,
        batchTimeout: 150
      },
      caching: {
        maxSize: 200 * 1024 * 1024, // 200MB
        ttl: 900000 // 15 minutes
      },
      compression: true,
      streamOptimization: true
    }
  });
  
  // Simulate realistic workload
  console.log('Simulating production workload...');
  
  const workload = async () => {
    const queries = [
      'up',
      'rate(http_requests_total[5m])',
      'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))',
      'sum by (job) (rate(http_requests_total[5m]))',
      'avg_over_time(up[1h])',
    ];
    
    const results = [];
    for (const q of queries) {
      let count = 0;
      for await (const event of adapter.query(q)) {
        count++;
      }
      results.push(count);
    }
    return results;
  };
  
  // Run workload multiple times
  const iterations = 5;
  const times = [];
  
  for (let i = 0; i < iterations; i++) {
    const startTime = Date.now();
    await workload();
    const elapsed = Date.now() - startTime;
    times.push(elapsed);
    console.log(`Iteration ${i + 1}: ${elapsed}ms`);
  }
  
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`Average time: ${avgTime.toFixed(1)}ms`);
  
  // Show comprehensive stats
  const stats = adapter.getPerformanceStats();
  console.log('\nFinal Performance Statistics:');
  console.log(JSON.stringify(stats, null, 2));
  
  // Cleanup
  adapter.destroy();
}

/**
 * Main execution
 */
async function main() {
  console.log('Grafana Performance Optimization Examples');
  console.log('==========================================');
  
  if (!process.env.GRAFANA_TOKEN) {
    console.log('\n⚠️  Set GRAFANA_TOKEN environment variable for real testing.\n');
  }
  
  try {
    await basicOptimization();
    await customConnectionPool();
    await advancedCaching();
    await queryBatching();
    await streamOptimization();
    await compressionBenefits();
    await fullOptimization();
    
    console.log('\n✅ All optimization examples completed');
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
  basicOptimization,
  customConnectionPool,
  advancedCaching,
  queryBatching,
  streamOptimization,
  compressionBenefits,
  fullOptimization
};