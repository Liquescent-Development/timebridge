# Performance Tuning Guide

A comprehensive guide to optimizing the log-correlator package for high-performance log stream correlation in Electron applications.

## Table of Contents

- [Performance Overview](#performance-overview)
- [Benchmarking Your Setup](#benchmarking-your-setup)
- [Memory Optimization](#memory-optimization)
- [CPU Optimization](#cpu-optimization)
- [Network Optimization](#network-optimization)
- [Query Optimization](#query-optimization)
- [Scaling Strategies](#scaling-strategies)
- [Real-Time Performance Monitoring](#real-time-performance-monitoring)
- [Electron-Specific Optimizations](#electron-specific-optimizations)

## Performance Overview

### Target Performance Metrics

| Metric                        | Target               | Typical      | Maximum  | Notes                  |
| ----------------------------- | -------------------- | ------------ | -------- | ---------------------- |
| **First Correlation Latency** | <100ms               | 50-80ms      | 200ms    | Time to first result   |
| **Event Throughput**          | 1000 events/sec      | 800-1200/sec | 5000/sec | Events processed       |
| **Memory Usage**              | <100MB               | 50-80MB      | 500MB    | Heap memory            |
| **CPU Usage**                 | <50% single core     | 30-40%       | 100%     | Per correlation engine |
| **Correlation Rate**          | 100 correlations/sec | 80-120/sec   | 500/sec  | Output rate            |
| **WebSocket Reconnects**      | <1/hour              | 0-2/hour     | 5/hour   | Connection stability   |

### Quick Performance Wins

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");

// Before optimization: ~200ms latency, 500 events/sec
const basicEngine = new CorrelationEngine();

// After optimization: ~50ms latency, 2000 events/sec
const optimizedEngine = new CorrelationEngine({
  // Memory optimizations
  maxEvents: 5000, // Reduce from default 10000
  bufferSize: 500, // Smaller buffers for faster processing

  // Processing optimizations
  processingInterval: 50, // More frequent processing (default: 100ms)
  lateTolerance: 30000, // 30s tolerance for out-of-order events

  // Cleanup optimizations
  gcInterval: 60000, // GC every minute (default: 30s)
  maxMemoryMB: 150, // Set memory limit
});

// Use optimized adapter configurations
const { LokiAdapter } = require("@liquescent/log-correlator-adapters-loki");
const lokiAdapter = new LokiAdapter({
  url: "http://localhost:3100",
  websocket: true, // Use WebSocket for real-time
  maxRetries: 5,
  timeout: 30000,
});

optimizedEngine.addAdapter("loki", lokiAdapter);

// Performance monitoring
optimizedEngine.on("memoryWarning", ({ usedMB }) => {
  if (usedMB > 100) {
    console.warn(`High memory usage: ${usedMB}MB`);
  }
});
```

## Benchmarking Your Setup

### Comprehensive Benchmark Script

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { LokiAdapter } = require("@liquescent/log-correlator-adapters-loki");
const { performance } = require("perf_hooks");

class PerformanceBenchmark {
  constructor() {
    this.results = [];
  }

  async benchmark(name, config = {}, testQuery, duration = 30000) {
    console.log(`\n=== Benchmarking: ${name} ===`);

    const engine = new CorrelationEngine(config);
    const lokiAdapter = new LokiAdapter({ url: "http://localhost:3100" });
    engine.addAdapter("loki", lokiAdapter);

    const metrics = {
      name,
      startTime: Date.now(),
      correlations: 0,
      firstCorrelationTime: null,
      errors: 0,
      memoryPeakMB: 0,
      avgLatency: 0,
      latencies: [],
    };

    // Monitor memory usage
    const memoryMonitor = setInterval(() => {
      const usage = process.memoryUsage();
      const heapMB = usage.heapUsed / 1024 / 1024;
      metrics.memoryPeakMB = Math.max(metrics.memoryPeakMB, heapMB);
    }, 1000);

    try {
      const correlationStart = performance.now();
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(resolve, duration)
      );

      const correlationPromise = (async () => {
        for await (const correlation of engine.correlate(testQuery)) {
          metrics.correlations++;

          if (metrics.correlations === 1) {
            metrics.firstCorrelationTime = performance.now() - correlationStart;
          }

          // Record latency
          const latency = performance.now() - correlationStart;
          metrics.latencies.push(latency);
        }
      })();

      await Promise.race([correlationPromise, timeoutPromise]);
    } catch (error) {
      metrics.errors++;
      console.error("Benchmark error:", error.message);
    } finally {
      clearInterval(memoryMonitor);
      await engine.destroy();
    }

    // Calculate final metrics
    const totalTime = Date.now() - metrics.startTime;
    metrics.duration = totalTime;
    metrics.throughput = (metrics.correlations / totalTime) * 1000;
    metrics.avgLatency =
      metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length ||
      0;

    this.results.push(metrics);
    this.printResults(metrics);

    return metrics;
  }

  printResults(metrics) {
    console.log(`Correlations: ${metrics.correlations}`);
    console.log(`Duration: ${metrics.duration}ms`);
    console.log(
      `Throughput: ${metrics.throughput.toFixed(2)} correlations/sec`
    );
    console.log(
      `First correlation: ${metrics.firstCorrelationTime?.toFixed(2)}ms`
    );
    console.log(`Average latency: ${metrics.avgLatency.toFixed(2)}ms`);
    console.log(`Peak memory: ${metrics.memoryPeakMB.toFixed(2)}MB`);
    console.log(`Errors: ${metrics.errors}`);
  }

  compare() {
    console.log("\n=== Benchmark Comparison ===");
    console.log("Name\t\tThroughput\tLatency\t\tMemory\t\tFirst Result");

    for (const result of this.results) {
      console.log(
        `${result.name.padEnd(12)}\t` +
          `${result.throughput.toFixed(1)}\t\t` +
          `${result.avgLatency.toFixed(1)}ms\t\t` +
          `${result.memoryPeakMB.toFixed(1)}MB\t\t` +
          `${result.firstCorrelationTime?.toFixed(1)}ms`
      );
    }
  }
}

// Usage example
async function runBenchmarks() {
  const benchmark = new PerformanceBenchmark();
  const testQuery =
    'loki({service="frontend"})[5m] and on(request_id) loki({service="backend"})[5m]';

  // Test different configurations
  await benchmark.benchmark("Default", {}, testQuery);

  await benchmark.benchmark(
    "Optimized",
    {
      maxEvents: 5000,
      bufferSize: 500,
      processingInterval: 50,
    },
    testQuery
  );

  await benchmark.benchmark(
    "Memory-Limited",
    {
      maxEvents: 1000,
      bufferSize: 100,
      maxMemoryMB: 50,
    },
    testQuery
  );

  benchmark.compare();
}
```

### Load Testing for High-Volume Scenarios

```javascript
class LoadTest {
  constructor(options = {}) {
    this.options = {
      duration: 60000, // 1 minute test
      concurrentEngines: 1, // Number of parallel engines
      eventsPerSecond: 1000, // Target event rate
      warmupTime: 10000, // 10s warmup
      ...options,
    };

    this.metrics = {
      totalCorrelations: 0,
      errors: 0,
      latencies: [],
      memoryPeak: 0,
      cpuUsage: [],
      timestamps: [],
    };
  }

  async run(testQuery) {
    console.log("Starting load test...");
    console.log(`Duration: ${this.options.duration}ms`);
    console.log(`Concurrent engines: ${this.options.concurrentEngines}`);
    console.log(`Target rate: ${this.options.eventsPerSecond} events/sec`);

    // Warmup period
    console.log("\nWarming up...");
    await this.warmup(testQuery);

    // Main test
    console.log("Starting main test...");
    const startTime = Date.now();

    // Start monitoring
    const monitorInterval = this.startMonitoring();

    try {
      // Run multiple engines in parallel
      const enginePromises = [];
      for (let i = 0; i < this.options.concurrentEngines; i++) {
        enginePromises.push(this.runSingleEngine(testQuery, i));
      }

      await Promise.all(enginePromises);
    } finally {
      clearInterval(monitorInterval);
    }

    const totalTime = Date.now() - startTime;
    this.calculateResults(totalTime);
    this.printResults();

    return this.metrics;
  }

  async warmup(testQuery) {
    const engine = new CorrelationEngine({ maxEvents: 1000 });
    const adapter = new LokiAdapter({ url: "http://localhost:3100" });
    engine.addAdapter("loki", adapter);

    try {
      let count = 0;
      const timeout = setTimeout(() => {}, this.options.warmupTime);

      for await (const correlation of engine.correlate(testQuery)) {
        count++;
        if (count >= 100) break; // Just a few correlations for warmup
      }

      clearTimeout(timeout);
    } catch (error) {
      console.warn("Warmup error:", error.message);
    } finally {
      await engine.destroy();
    }
  }

  async runSingleEngine(testQuery, engineId) {
    const engine = new CorrelationEngine({
      maxEvents: 5000,
      bufferSize: 500,
      processingInterval: 50,
    });

    const adapter = new LokiAdapter({ url: "http://localhost:3100" });
    engine.addAdapter("loki", adapter);

    const startTime = performance.now();
    let correlationCount = 0;

    try {
      const timeout = setTimeout(() => {}, this.options.duration);

      for await (const correlation of engine.correlate(testQuery)) {
        correlationCount++;
        this.metrics.totalCorrelations++;

        const latency = performance.now() - startTime;
        this.metrics.latencies.push(latency);
        this.metrics.timestamps.push(Date.now());
      }

      clearTimeout(timeout);
    } catch (error) {
      this.metrics.errors++;
      console.error(`Engine ${engineId} error:`, error.message);
    } finally {
      await engine.destroy();
    }
  }

  startMonitoring() {
    return setInterval(() => {
      const usage = process.memoryUsage();
      const memoryMB = usage.heapUsed / 1024 / 1024;
      this.metrics.memoryPeak = Math.max(this.metrics.memoryPeak, memoryMB);

      const cpuUsage = process.cpuUsage();
      this.metrics.cpuUsage.push(cpuUsage);
    }, 1000);
  }

  calculateResults(totalTime) {
    // Sort latencies for percentile calculations
    const sorted = this.metrics.latencies.sort((a, b) => a - b);

    this.metrics.totalTime = totalTime;
    this.metrics.throughput =
      (this.metrics.totalCorrelations / totalTime) * 1000;
    this.metrics.successRate =
      (this.metrics.totalCorrelations /
        (this.metrics.totalCorrelations + this.metrics.errors)) *
      100;
    this.metrics.avgLatency =
      sorted.reduce((a, b) => a + b, 0) / sorted.length || 0;

    if (sorted.length > 0) {
      this.metrics.p50 = sorted[Math.floor(sorted.length * 0.5)];
      this.metrics.p95 = sorted[Math.floor(sorted.length * 0.95)];
      this.metrics.p99 = sorted[Math.floor(sorted.length * 0.99)];
    }
  }

  printResults() {
    console.log("\n=== Load Test Results ===");
    console.log(`Total correlations: ${this.metrics.totalCorrelations}`);
    console.log(`Total time: ${this.metrics.totalTime}ms`);
    console.log(
      `Throughput: ${this.metrics.throughput.toFixed(2)} correlations/sec`
    );
    console.log(`Success rate: ${this.metrics.successRate.toFixed(2)}%`);
    console.log(`Errors: ${this.metrics.errors}`);
    console.log(`Peak memory: ${this.metrics.memoryPeak.toFixed(2)}MB`);
    console.log(`Average latency: ${this.metrics.avgLatency.toFixed(2)}ms`);
    console.log(`P50 latency: ${this.metrics.p50?.toFixed(2)}ms`);
    console.log(`P95 latency: ${this.metrics.p95?.toFixed(2)}ms`);
    console.log(`P99 latency: ${this.metrics.p99?.toFixed(2)}ms`);
  }
}

// Usage
async function performLoadTest() {
  const loadTest = new LoadTest({
    duration: 120000, // 2 minute test
    concurrentEngines: 2, // Test with 2 parallel engines
    eventsPerSecond: 1500, // Higher target rate
  });

  const query =
    'loki({service="frontend"})[3m] and on(request_id) loki({service="backend"})[3m]';
  await loadTest.run(query);
}
```

## Memory Optimization

### Memory-Efficient Configuration

```javascript
// For limited memory environments (<100MB)
const lowMemoryConfig = {
  maxEvents: 1000, // Keep minimal events
  bufferSize: 100, // Small buffers
  defaultTimeWindow: "1m", // Short windows
  gcInterval: 30000, // Frequent GC
  maxMemoryMB: 50, // Hard limit
};

// For standard environments (100-500MB)
const standardConfig = {
  maxEvents: 5000,
  bufferSize: 500,
  defaultTimeWindow: "5m",
  gcInterval: 60000,
  maxMemoryMB: 200,
};

// For high-memory environments (>500MB)
const highMemoryConfig = {
  maxEvents: 20000,
  bufferSize: 2000,
  defaultTimeWindow: "10m",
  gcInterval: 120000,
  maxMemoryMB: 1000,
};
```

### Memory Profiling

```javascript
const v8 = require("v8");
const { writeHeapSnapshot } = v8;

// Take heap snapshots
function profileMemory(engine) {
  const snapshots = [];

  // Initial snapshot
  writeHeapSnapshot("heap-initial.heapsnapshot");

  // During correlation
  let eventCount = 0;
  engine.on("correlationFound", () => {
    eventCount++;
    if (eventCount % 1000 === 0) {
      const usage = process.memoryUsage();
      snapshots.push({
        events: eventCount,
        heapUsed: usage.heapUsed,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
      });

      // Take snapshot at milestones
      if (eventCount === 10000) {
        writeHeapSnapshot("heap-10k.heapsnapshot");
      }
    }
  });

  return snapshots;
}

// Analyze memory growth
function analyzeMemoryGrowth(snapshots) {
  const growth = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    growth.push({
      events: curr.events - prev.events,
      memoryIncrease: curr.heapUsed - prev.heapUsed,
      bytesPerEvent:
        (curr.heapUsed - prev.heapUsed) / (curr.events - prev.events),
    });
  }
  return growth;
}
```

### Preventing Memory Leaks

```javascript
// 1. Use weak references for caches
const WeakMap = require("weak-map");
const eventCache = new WeakMap();

// 2. Clear references after use
class CorrelationProcessor {
  constructor() {
    this.events = [];
  }

  async process() {
    try {
      // Process events
      await this.correlate();
    } finally {
      // Always clear references
      this.events = [];
      this.clearBuffers();
    }
  }

  clearBuffers() {
    this.buffer = null;
    this.cache = null;
    if (global.gc) global.gc();
  }
}

// 3. Use streaming to avoid accumulation
async function* streamWithCleanup(source) {
  const buffer = [];
  try {
    for await (const item of source) {
      buffer.push(item);
      if (buffer.length >= 100) {
        yield* buffer;
        buffer.length = 0; // Clear buffer
      }
    }
    if (buffer.length > 0) {
      yield* buffer;
    }
  } finally {
    buffer.length = 0; // Ensure cleanup
  }
}
```

## CPU Optimization

### Multi-Core Processing

```javascript
const { ParallelProcessor } = require("@liquescent/log-correlator-core");
const os = require("os");

// Optimize for available cores
const processor = new ParallelProcessor({
  maxWorkers: Math.max(1, os.cpus().length - 1), // Leave one core free
  taskQueueSize: 1000,
  workerIdleTimeout: 30000,
});

// Distribute correlation across workers
async function parallelCorrelation(streams) {
  const workers = [];
  const chunkSize = Math.ceil(streams.length / processor.maxWorkers);

  for (let i = 0; i < streams.length; i += chunkSize) {
    const chunk = streams.slice(i, i + chunkSize);
    workers.push(processor.processChunk(chunk));
  }

  const results = await Promise.all(workers);
  return mergeResults(results);
}
```

### CPU Profiling

```javascript
const { performance, PerformanceObserver } = require("perf_hooks");

// Profile function execution
function profileFunction(fn, name) {
  return async function (...args) {
    performance.mark(`${name}-start`);
    try {
      const result = await fn.apply(this, args);
      return result;
    } finally {
      performance.mark(`${name}-end`);
      performance.measure(name, `${name}-start`, `${name}-end`);
    }
  };
}

// Monitor performance
const obs = new PerformanceObserver((items) => {
  items.getEntries().forEach((entry) => {
    if (entry.duration > 100) {
      console.warn(`Slow operation: ${entry.name} took ${entry.duration}ms`);
    }
  });
});
obs.observe({ entryTypes: ["measure"] });

// Apply profiling
engine.correlate = profileFunction(engine.correlate, "correlate");
```

### Algorithm Optimization

```javascript
// 1. Use indexed lookups instead of linear search
class OptimizedJoinIndex {
  constructor() {
    this.index = new Map();
  }

  // O(1) insertion
  add(key, value, event) {
    if (!this.index.has(key)) {
      this.index.set(key, new Map());
    }
    const keyIndex = this.index.get(key);
    if (!keyIndex.has(value)) {
      keyIndex.set(value, []);
    }
    keyIndex.get(value).push(event);
  }

  // O(1) lookup
  find(key, value) {
    return this.index.get(key)?.get(value) || [];
  }
}

// 2. Use binary search for time ranges
function binarySearchTimeRange(events, startTime, endTime) {
  let left = 0;
  let right = events.length - 1;
  let startIndex = events.length;

  // Find start index
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (events[mid].timestamp >= startTime) {
      startIndex = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  // Find end index
  let endIndex = startIndex;
  while (endIndex < events.length && events[endIndex].timestamp <= endTime) {
    endIndex++;
  }

  return events.slice(startIndex, endIndex);
}
```

## Network Optimization

### Connection Pooling

```javascript
// Reuse connections for better performance
class ConnectionPool {
  constructor(maxConnections = 10) {
    this.pool = [];
    this.maxConnections = maxConnections;
    this.activeConnections = 0;
  }

  async getConnection() {
    if (this.pool.length > 0) {
      return this.pool.pop();
    }

    if (this.activeConnections < this.maxConnections) {
      this.activeConnections++;
      return this.createConnection();
    }

    // Wait for available connection
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.pool.length > 0) {
          clearInterval(checkInterval);
          resolve(this.pool.pop());
        }
      }, 100);
    });
  }

  releaseConnection(conn) {
    if (this.pool.length < this.maxConnections) {
      this.pool.push(conn);
    } else {
      conn.close();
      this.activeConnections--;
    }
  }
}
```

### Request Batching

```javascript
// Batch multiple requests to reduce network overhead
class BatchedAdapter {
  constructor(adapter, batchSize = 100, batchInterval = 100) {
    this.adapter = adapter;
    this.batchSize = batchSize;
    this.batchInterval = batchInterval;
    this.batch = [];
    this.batchTimer = null;
  }

  async query(params) {
    return new Promise((resolve, reject) => {
      this.batch.push({ params, resolve, reject });

      if (this.batch.length >= this.batchSize) {
        this.flush();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flush(), this.batchInterval);
      }
    });
  }

  async flush() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batch.length === 0) return;

    const currentBatch = this.batch;
    this.batch = [];

    try {
      const results = await this.adapter.batchQuery(
        currentBatch.map((b) => b.params)
      );

      currentBatch.forEach((item, index) => {
        item.resolve(results[index]);
      });
    } catch (error) {
      currentBatch.forEach((item) => item.reject(error));
    }
  }
}
```

### Compression

```javascript
const zlib = require("zlib");

// Enable compression for large payloads
class CompressedAdapter {
  async sendRequest(data) {
    const serialized = JSON.stringify(data);

    // Compress if large
    if (serialized.length > 1024) {
      const compressed = await promisify(zlib.gzip)(serialized);
      return fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body: compressed,
      });
    }

    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized,
    });
  }
}
```

## Query Optimization

### Query Analysis

```javascript
// Analyze query complexity
function analyzeQuery(query) {
  const parser = new PeggyQueryParser();
  const parsed = parser.parse(query);

  return {
    streams: parsed.streams.length,
    timeWindow: parseTimeWindow(parsed.timeRange),
    joinKeys: parsed.joinKeys.length,
    hasFilter: !!parsed.filter,
    hasTemporal: !!parsed.temporal,
    hasGrouping: !!parsed.grouping,
    complexity: calculateComplexity(parsed),
  };
}

function calculateComplexity(parsed) {
  let score = 0;
  score += parsed.streams.length * 10; // Each stream adds complexity
  score += parsed.joinKeys.length * 5; // Each join key
  score += parsed.hasFilter ? 20 : 0; // Filtering overhead
  score += parsed.hasTemporal ? 15 : 0; // Temporal constraints
  score += parsed.hasGrouping ? 25 : 0; // Grouping overhead

  return {
    score,
    level: score < 30 ? "simple" : score < 60 ? "moderate" : "complex",
  };
}
```

### Query Optimization Strategies

```javascript
// 1. Push filters to source
// Instead of:
const inefficient = `
  (loki({service="frontend"})[10m] 
    and on(request_id) 
    loki({service="backend"})[10m])
  {status="500"}
`;

// Use:
const efficient = `
  loki({service="frontend", status="500"})[10m] 
    and on(request_id) 
    loki({service="backend", status="500"})[10m]
`;

// 2. Reduce time windows
// Instead of:
const largeWindow = 'loki({service="api"})[1h]';

// Use:
const smallWindow = 'loki({service="api"})[5m]';

// 3. Use specific join keys
// Instead of:
const multipleKeys = "and on(request_id, session_id, user_id)";

// Use:
const singleKey = "and on(request_id)";

// 4. Limit result set early
async function optimizedQuery(engine, query) {
  const limit = 1000;
  const results = [];

  for await (const correlation of engine.correlate(query)) {
    results.push(correlation);
    if (results.length >= limit) break; // Stop early
  }

  return results;
}
```

### Query Caching

```javascript
const crypto = require("crypto");

class QueryCache {
  constructor(ttl = 60000) {
    // 1 minute TTL
    this.cache = new Map();
    this.ttl = ttl;
  }

  getCacheKey(query, options) {
    const hash = crypto.createHash("sha256");
    hash.update(query);
    hash.update(JSON.stringify(options));
    return hash.digest("hex");
  }

  async execute(engine, query, options = {}) {
    const key = this.getCacheKey(query, options);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.results;
    }

    const results = [];
    for await (const correlation of engine.correlate(query)) {
      results.push(correlation);
    }

    this.cache.set(key, {
      results,
      timestamp: Date.now(),
    });

    // Clean old entries
    this.cleanup();

    return results;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }
}
```

## Scaling Strategies

### Horizontal Scaling

```javascript
// Distribute correlation across multiple instances
const cluster = require("cluster");
const numCPUs = require("os").cpus().length;

if (cluster.isMaster) {
  // Master process
  const workers = [];

  for (let i = 0; i < numCPUs; i++) {
    workers.push(cluster.fork());
  }

  // Load balancing
  let currentWorker = 0;

  async function distributeQuery(query) {
    const worker = workers[currentWorker];
    currentWorker = (currentWorker + 1) % workers.length;

    return new Promise((resolve) => {
      worker.send({ type: "query", query });
      worker.once("message", (msg) => {
        if (msg.type === "result") {
          resolve(msg.results);
        }
      });
    });
  }
} else {
  // Worker process
  const engine = new CorrelationEngine(workerConfig);

  process.on("message", async (msg) => {
    if (msg.type === "query") {
      const results = [];
      for await (const correlation of engine.correlate(msg.query)) {
        results.push(correlation);
      }
      process.send({ type: "result", results });
    }
  });
}
```

### Sharding

```javascript
// Shard data by time or key
class ShardedEngine {
  constructor(shardCount = 4) {
    this.shards = [];
    for (let i = 0; i < shardCount; i++) {
      this.shards.push(
        new CorrelationEngine({
          shardId: i,
          shardCount: shardCount,
        })
      );
    }
  }

  getShardForEvent(event) {
    // Shard by request_id hash
    const hash = crypto
      .createHash("sha256")
      .update(event.joinKeys.request_id || "")
      .digest();
    const shardIndex = hash[0] % this.shards.length;
    return this.shards[shardIndex];
  }

  async *correlate(query) {
    // Query all shards in parallel
    const streams = this.shards.map((shard) => shard.correlate(query));

    // Merge results
    yield* this.mergeStreams(streams);
  }

  async *mergeStreams(streams) {
    const iterators = streams.map((s) => s[Symbol.asyncIterator]());
    const pending = new Set(iterators);

    while (pending.size > 0) {
      const promises = Array.from(pending).map((it) =>
        it.next().then((result) => ({ iterator: it, result }))
      );

      const { iterator, result } = await Promise.race(promises);

      if (result.done) {
        pending.delete(iterator);
      } else {
        yield result.value;
      }
    }
  }
}
```

## Performance Monitoring

### Real-Time Metrics

```javascript
const { PerformanceMonitor } = require("@liquescent/log-correlator-core");

class DetailedMonitor extends PerformanceMonitor {
  constructor() {
    super(1000); // 1 second intervals
    this.metrics = {
      events: 0,
      correlations: 0,
      errors: 0,
      latencies: [],
    };
  }

  recordEvent(type, duration) {
    this.metrics.events++;
    this.metrics.latencies.push(duration);

    // Keep only last 1000 latencies
    if (this.metrics.latencies.length > 1000) {
      this.metrics.latencies.shift();
    }
  }

  getStatistics() {
    const sorted = [...this.metrics.latencies].sort((a, b) => a - b);
    return {
      count: this.metrics.events,
      correlations: this.metrics.correlations,
      errors: this.metrics.errors,
      throughput: this.metrics.events / (this.uptime / 1000),
      latency: {
        min: Math.min(...sorted),
        max: Math.max(...sorted),
        avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
      },
    };
  }
}

// Use monitor
const monitor = new DetailedMonitor();
monitor.start();

setInterval(() => {
  const stats = monitor.getStatistics();
  console.log("Performance Stats:", stats);

  // Alert on degradation
  if (stats.latency.p95 > 200) {
    console.warn("High latency detected!");
  }
  if (stats.throughput < 100) {
    console.warn("Low throughput detected!");
  }
}, 5000);
```

### Performance Dashboard

```javascript
// Export metrics for monitoring tools
const prometheus = require("prom-client");

// Create metrics
const eventCounter = new prometheus.Counter({
  name: "correlation_events_total",
  help: "Total number of events processed",
});

const correlationHistogram = new prometheus.Histogram({
  name: "correlation_duration_seconds",
  help: "Correlation duration in seconds",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

const memoryGauge = new prometheus.Gauge({
  name: "correlation_memory_bytes",
  help: "Memory usage in bytes",
});

// Track metrics
engine.on("correlationFound", (correlation) => {
  eventCounter.inc();
  correlationHistogram.observe(correlation.duration / 1000);
});

setInterval(() => {
  memoryGauge.set(process.memoryUsage().heapUsed);
}, 10000);

// Expose metrics endpoint
const express = require("express");
const app = express();

app.get("/metrics", (req, res) => {
  res.set("Content-Type", prometheus.register.contentType);
  res.end(prometheus.register.metrics());
});

app.listen(9090);
```

## Electron-Specific Optimizations

### Main Process vs Renderer Process

**Recommendation**: Run correlation engine in the main process for better performance and resource management.

```javascript
// main.js (Main Process)
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { ipcMain } = require("electron");

class ElectronCorrelationService {
  constructor() {
    this.engines = new Map();
    this.setupIPC();
  }

  setupIPC() {
    // Handle correlation requests from renderer
    ipcMain.handle(
      "start-correlation",
      async (event, { id, query, config }) => {
        try {
          const engine = new CorrelationEngine({
            maxEvents: 2000, // Smaller for Electron
            bufferSize: 200,
            maxMemoryMB: 100,
            ...config,
          });

          this.engines.set(id, engine);

          // Stream results back to renderer
          this.streamResults(id, engine, query, event.sender);

          return { success: true };
        } catch (error) {
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("stop-correlation", async (event, { id }) => {
      const engine = this.engines.get(id);
      if (engine) {
        await engine.destroy();
        this.engines.delete(id);
      }
      return { success: true };
    });
  }

  async streamResults(id, engine, query, sender) {
    try {
      for await (const correlation of engine.correlate(query)) {
        // Send results to renderer in chunks
        sender.send("correlation-result", { id, correlation });

        // Yield control to prevent blocking
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      sender.send("correlation-error", { id, error: error.message });
    }
  }
}

const correlationService = new ElectronCorrelationService();
```

````javascript
// renderer.js (Renderer Process)
const { ipcRenderer } = require('electron');

class CorrelationClient {
  constructor() {
    this.activeCorrelations = new Map();
    this.setupListeners();
  }

  setupListeners() {
    ipcRenderer.on('correlation-result', (event, { id, correlation }) => {
      const handler = this.activeCorrelations.get(id);
      if (handler && handler.onResult) {
        handler.onResult(correlation);
      }
    });

    ipcRenderer.on('correlation-error', (event, { id, error }) => {
      const handler = this.activeCorrelations.get(id);
      if (handler && handler.onError) {
        handler.onError(new Error(error));
      }
    });
  }

  async startCorrelation(query, options = {}) {\n    const id = `correlation-${Date.now()}`;\n    \n    const result = await ipcRenderer.invoke('start-correlation', {\n      id,\n      query,\n      config: {\n        maxEvents: 1000,     // Smaller for UI responsiveness\n        processingInterval: 100\n      }\n    });\n    \n    if (!result.success) {\n      throw new Error(result.error);\n    }\n    \n    return {\n      id,\n      onResult: (callback) => {\n        const handler = this.activeCorrelations.get(id) || {};\n        handler.onResult = callback;\n        this.activeCorrelations.set(id, handler);\n      },\n      onError: (callback) => {\n        const handler = this.activeCorrelations.get(id) || {};\n        handler.onError = callback;\n        this.activeCorrelations.set(id, handler);\n      },\n      stop: async () => {\n        await ipcRenderer.invoke('stop-correlation', { id });\n        this.activeCorrelations.delete(id);\n      }\n    };\n  }\n}\n\n// Usage in renderer\nconst client = new CorrelationClient();\n\nasync function startUICorrelation() {\n  const correlation = await client.startCorrelation(\n    'loki({service=\"frontend\"})[2m] and on(request_id) loki({service=\"backend\"})[2m]'\n  );\n  \n  correlation.onResult((result) => {\n    // Update UI with new correlation\n    updateCorrelationTable(result);\n  });\n  \n  correlation.onError((error) => {\n    showErrorToast(error.message);\n  });\n  \n  // Stop correlation when component unmounts\n  return () => correlation.stop();\n}\n```

### Memory Management in Electron

```javascript
// Monitor memory usage in Electron\nfunction setupElectronMemoryMonitoring() {\n  const { app } = require('electron');\n  \n  // Monitor system memory\n  setInterval(() => {\n    const systemMemory = process.getSystemMemoryInfo();\n    const processMemory = process.getProcessMemoryInfo();\n    \n    console.log('System Memory:', {\n      total: `${(systemMemory.total / 1024).toFixed(0)}MB`,\n      free: `${(systemMemory.free / 1024).toFixed(0)}MB`\n    });\n    \n    console.log('Process Memory:', {\n      workingSetSize: `${(processMemory.workingSetSize / 1024).toFixed(0)}MB`,\n      private: `${(processMemory.private / 1024).toFixed(0)}MB`\n    });\n    \n    // Trigger GC if memory usage is high\n    if (processMemory.private > 200 * 1024) { // 200MB\n      if (global.gc) {\n        console.log('Triggering garbage collection');\n        global.gc();\n      }\n    }\n  }, 30000);\n  \n  // Handle low memory warnings\n  app.on('render-process-gone', (event, webContents, details) => {\n    if (details.reason === 'oom') {\n      console.error('Renderer process OOM - reducing correlation engine memory limits');\n      // Restart with lower memory configuration\n    }\n  });\n}\n```

### Optimizing for UI Responsiveness

```javascript\n// Batch correlation results to prevent UI freezing\nclass UIOptimizedCorrelationStream {\n  constructor(engine, batchSize = 10, batchInterval = 100) {\n    this.engine = engine;\n    this.batchSize = batchSize;\n    this.batchInterval = batchInterval;\n  }\n  \n  async *correlate(query) {\n    let batch = [];\n    let lastFlush = Date.now();\n    \n    for await (const correlation of this.engine.correlate(query)) {\n      batch.push(correlation);\n      \n      const now = Date.now();\n      const shouldFlush = batch.length >= this.batchSize || \n                         (now - lastFlush) >= this.batchInterval;\n      \n      if (shouldFlush) {\n        yield batch;\n        batch = [];\n        lastFlush = now;\n        \n        // Yield control to UI thread\n        await new Promise(resolve => setImmediate(resolve));\n      }\n    }\n    \n    // Flush remaining items\n    if (batch.length > 0) {\n      yield batch;\n    }\n  }\n}\n\n// Usage\nconst uiStream = new UIOptimizedCorrelationStream(engine, 5, 50);\n\nfor await (const batch of uiStream.correlate(query)) {\n  // Update UI with batch of correlations\n  batch.forEach(correlation => {\n    addCorrelationToTable(correlation);\n  });\n  \n  // Allow UI to update\n  await new Promise(resolve => requestIdleCallback(resolve));\n}\n```

## Best Practices Summary

### Configuration Checklist for Production

**Engine Configuration**:
- [ ] Set appropriate time windows (start with 2-5m for most use cases)
- [ ] Configure memory limits based on available resources (50-200MB typical)
- [ ] Set bufferSize to 10-20% of maxEvents
- [ ] Configure processingInterval based on latency requirements (50-100ms)
- [ ] Set gcInterval to balance memory usage and performance (30-60s)
- [ ] Enable lateTolerance for out-of-order events (30-60s)

**Adapter Configuration**:
- [ ] Use WebSocket mode for Loki when possible (real-time streaming)
- [ ] Configure appropriate timeouts (30-60s for most networks)
- [ ] Set retry policies with exponential backoff
- [ ] Use authentication tokens rather than username/password
- [ ] Configure connection pooling for high-volume scenarios
- [ ] Set up health checks and fallback mechanisms

**Monitoring & Alerting**:
- [ ] Implement memory usage monitoring
- [ ] Set up correlation rate monitoring
- [ ] Monitor WebSocket connection stability
- [ ] Track query parsing errors
- [ ] Monitor adapter connection health
- [ ] Set up alerts for performance degradation
- [ ] Implement log correlation performance metrics

**Electron-Specific**:
- [ ] Run correlation engine in main process
- [ ] Implement IPC batching for UI updates
- [ ] Configure smaller memory limits for renderer processes
- [ ] Use worker threads for CPU-intensive operations
- [ ] Implement graceful degradation for low-resource scenarios

### Performance Testing Checklist

**Benchmarking**:
- [ ] Benchmark with realistic data volumes (1K-10K events)
- [ ] Test different query complexities (simple, multi-stream, temporal)
- [ ] Measure first correlation latency (<100ms target)
- [ ] Test sustained throughput (target 1000+ events/sec)
- [ ] Benchmark memory usage patterns over time

**Load Testing**:
- [ ] Test with peak load scenarios (2-5x normal volume)
- [ ] Run extended duration tests (30+ minutes)
- [ ] Test concurrent correlation engines
- [ ] Verify performance under memory pressure
- [ ] Test with network latency and packet loss

**Stress Testing**:
- [ ] Test WebSocket reconnection under poor network conditions
- [ ] Verify graceful degradation when memory limits exceeded
- [ ] Test adapter failover and recovery
- [ ] Verify correlation accuracy under high load
- [ ] Test system behavior during data source outages

**Monitoring Validation**:
- [ ] Verify memory leak detection works correctly
- [ ] Test performance metric accuracy
- [ ] Validate alert thresholds trigger appropriately
- [ ] Confirm log correlation tracing works end-to-end
- [ ] Test diagnostic report generation

### Recommended Configurations by Use Case

**Development/Testing**:
```javascript
{
  defaultTimeWindow: '2m',
  maxEvents: 1000,
  bufferSize: 100,
  maxMemoryMB: 50,
  processingInterval: 200
}
````

**Production (Normal Load)**:

```javascript
{
  defaultTimeWindow: '5m',
  maxEvents: 5000,
  bufferSize: 500,
  maxMemoryMB: 150,
  processingInterval: 100,
  gcInterval: 60000
}
```

**Production (High Load)**:

```javascript
{
  defaultTimeWindow: '3m',
  maxEvents: 10000,
  bufferSize: 1000,
  maxMemoryMB: 300,
  processingInterval: 50,
  gcInterval: 30000
}
```

**Electron Desktop App**:

```javascript
{
  defaultTimeWindow: '2m',
  maxEvents: 2000,
  bufferSize: 200,
  maxMemoryMB: 100,
  processingInterval: 100
}
```
