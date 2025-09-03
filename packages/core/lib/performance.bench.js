"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerformanceBenchmark = void 0;
const correlation_engine_1 = require("./correlation-engine");
/**
 * Performance benchmark suite for the log correlation engine
 * Tests various join types, data volumes, and time window configurations
 */
// Mock data source adapter for benchmarking
class MockAdapter {
  constructor(name, events = []) {
    this.name = name;
    this.events = [];
    this.events = events;
  }
  getName() {
    return this.name;
  }
  async *createStream(_query, _options) {
    for (const event of this.events) {
      yield event;
    }
  }
  validateQuery(_query) {
    return true;
  }
  async getAvailableStreams() {
    return ["test-stream"];
  }
  async destroy() {
    // No-op for mock
  }
}
class PerformanceBenchmark {
  constructor() {
    this.results = [];
  }
  /**
   * Generate synthetic log events for testing
   */
  generateEvents(count, source, baseTime = new Date()) {
    const events = [];
    const joinKeys = ["req_123", "req_456", "req_789", "req_999", "req_888"];
    const services = ["frontend", "backend", "database", "cache", "auth"];
    for (let i = 0; i < count; i++) {
      const timestamp = new Date(baseTime.getTime() + i * 100); // 100ms apart
      const joinKey = joinKeys[i % joinKeys.length];
      const service = services[i % services.length];
      events.push({
        timestamp: timestamp.toISOString(),
        source,
        stream: service,
        message: `${source} processing request ${joinKey} from ${service}`,
        labels: {
          service,
          level: i % 10 === 0 ? "error" : "info",
          region: i % 2 === 0 ? "us-east-1" : "us-west-2",
        },
        joinKeys: {
          request_id: joinKey,
          trace_id: `trace_${joinKey}`,
          session_id: `session_${Math.floor(i / 10)}`,
        },
      });
    }
    return events;
  }
  /**
   * Generate correlated events across multiple sources
   */
  generateCorrelatedEvents(eventCount, sourceCount) {
    const sources = new Map();
    const baseTime = new Date();
    for (let s = 0; s < sourceCount; s++) {
      const sourceName = `source_${s}`;
      const events = this.generateEvents(
        eventCount,
        sourceName,
        new Date(baseTime.getTime() + s * 50)
      ); // Slight offset per source
      sources.set(sourceName, events);
    }
    return sources;
  }
  /**
   * Measure memory usage
   */
  getMemoryUsage() {
    if (global.gc) {
      global.gc();
    }
    return process.memoryUsage();
  }
  /**
   * Run a single benchmark
   */
  async runBenchmark(name, engine, query, adapters, _expectedCorrelations = 0) {
    const startMemory = this.getMemoryUsage();
    const startTime = process.hrtime.bigint();
    let eventsProcessed = 0;
    let correlationsFound = 0;
    // Register adapters
    for (const [name, adapter] of adapters) {
      engine.addAdapter(name, adapter);
    }
    // Set up correlation listener
    engine.on("correlationFound", (_correlation) => {
      correlationsFound++;
    });
    try {
      // Execute correlation
      const correlationStream = engine.correlate(query);
      for await (const correlation of correlationStream) {
        eventsProcessed += correlation.events.length;
      }
    } catch (error) {
      console.error(`Benchmark ${name} failed:`, error);
    }
    const endTime = process.hrtime.bigint();
    const endMemory = this.getMemoryUsage();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    const throughput = eventsProcessed / (duration / 1000); // Events per second
    const result = {
      name,
      duration,
      memoryUsage: {
        heapUsed: endMemory.heapUsed - startMemory.heapUsed,
        heapTotal: endMemory.heapTotal - startMemory.heapTotal,
        external: endMemory.external - startMemory.external,
        rss: endMemory.rss - startMemory.rss,
      },
      eventsProcessed,
      correlationsFound,
      throughput,
    };
    await engine.destroy();
    return result;
  }
  /**
   * Benchmark different join types
   */
  async benchmarkJoinTypes(options = {}) {
    const eventCount = 1000;
    const joinTypes = options.joinTypes || ["inner", "left", "outer"];
    console.log("\n=== JOIN TYPE BENCHMARKS ===");
    for (const joinType of joinTypes) {
      const engine = new correlation_engine_1.CorrelationEngine({
        timeWindow: 30000, // 30 seconds
        joinType,
        maxEvents: 10000,
      });
      const sources = this.generateCorrelatedEvents(eventCount, 2);
      const adapters = new Map();
      for (const [sourceName, events] of sources) {
        adapters.set(sourceName, new MockAdapter(sourceName, events));
      }
      const query = `source_0({}) ${joinType} on(request_id) source_1({})`;
      const result = await this.runBenchmark(
        `${joinType.toUpperCase()} Join - ${eventCount} events`,
        engine,
        query,
        adapters
      );
      this.results.push(result);
      this.printResult(result);
    }
  }
  /**
   * Benchmark different data volumes
   */
  async benchmarkDataVolumes(options = {}) {
    const eventCounts = options.eventCounts || [100, 500, 1000, 5000, 10000];
    console.log("\n=== DATA VOLUME BENCHMARKS ===");
    for (const eventCount of eventCounts) {
      const engine = new correlation_engine_1.CorrelationEngine({
        timeWindow: 30000,
        joinType: "inner",
        maxEvents: eventCount * 2,
      });
      const sources = this.generateCorrelatedEvents(eventCount, 2);
      const adapters = new Map();
      for (const [sourceName, events] of sources) {
        adapters.set(sourceName, new MockAdapter(sourceName, events));
      }
      const query = `source_0({}) and on(request_id) source_1({})`;
      const result = await this.runBenchmark(
        `Inner Join - ${eventCount} events per source`,
        engine,
        query,
        adapters
      );
      this.results.push(result);
      this.printResult(result);
    }
  }
  /**
   * Benchmark different time window sizes
   */
  async benchmarkTimeWindows(options = {}) {
    const timeWindows = options.timeWindows || ["5s", "30s", "2m", "5m", "10m"];
    const eventCount = 1000;
    console.log("\n=== TIME WINDOW BENCHMARKS ===");
    for (const timeWindow of timeWindows) {
      const engine = new correlation_engine_1.CorrelationEngine({
        defaultTimeWindow: timeWindow,
        joinType: "inner",
        maxEvents: 10000,
      });
      const sources = this.generateCorrelatedEvents(eventCount, 2);
      const adapters = new Map();
      for (const [sourceName, events] of sources) {
        adapters.set(sourceName, new MockAdapter(sourceName, events));
      }
      const query = `source_0({})[${timeWindow}] and on(request_id) source_1({})[${timeWindow}]`;
      const result = await this.runBenchmark(
        `Time Window ${timeWindow} - ${eventCount} events`,
        engine,
        query,
        adapters
      );
      this.results.push(result);
      this.printResult(result);
    }
  }
  /**
   * Benchmark multi-stream correlations
   */
  async benchmarkMultiStream(_options = {}) {
    const streamCounts = [2, 3, 4, 5];
    const eventCount = 500;
    console.log("\n=== MULTI-STREAM BENCHMARKS ===");
    for (const streamCount of streamCounts) {
      const engine = new correlation_engine_1.CorrelationEngine({
        timeWindow: 30000,
        joinType: "inner",
        maxEvents: eventCount * streamCount,
      });
      const sources = this.generateCorrelatedEvents(eventCount, streamCount);
      const adapters = new Map();
      for (const [sourceName, events] of sources) {
        adapters.set(sourceName, new MockAdapter(sourceName, events));
      }
      // Build complex multi-stream query
      let query = "source_0({})";
      for (let i = 1; i < streamCount; i++) {
        query += ` and on(request_id) source_${i}({})`;
      }
      const result = await this.runBenchmark(
        `Multi-stream (${streamCount} streams) - ${eventCount} events each`,
        engine,
        query,
        adapters
      );
      this.results.push(result);
      this.printResult(result);
    }
  }
  /**
   * Benchmark memory usage under load
   */
  async benchmarkMemoryUsage() {
    console.log("\n=== MEMORY USAGE BENCHMARKS ===");
    const scenarios = [
      { eventCount: 10000, bufferSize: 1000, name: "Standard Load" },
      { eventCount: 50000, bufferSize: 5000, name: "Heavy Load" },
      { eventCount: 100000, bufferSize: 10000, name: "Extreme Load" },
    ];
    for (const scenario of scenarios) {
      const engine = new correlation_engine_1.CorrelationEngine({
        timeWindow: 60000, // 1 minute
        joinType: "inner",
        maxEvents: scenario.eventCount,
        bufferSize: scenario.bufferSize,
        maxMemoryMB: 512, // 512 MB limit
      });
      const sources = this.generateCorrelatedEvents(scenario.eventCount, 2);
      const adapters = new Map();
      for (const [sourceName, events] of sources) {
        adapters.set(sourceName, new MockAdapter(sourceName, events));
      }
      const query = `source_0({}) and on(request_id) source_1({})`;
      const result = await this.runBenchmark(
        `${scenario.name} - ${scenario.eventCount} events`,
        engine,
        query,
        adapters
      );
      this.results.push(result);
      this.printResult(result);
    }
  }
  /**
   * Benchmark late-arriving events
   */
  async benchmarkLateEvents() {
    console.log("\n=== LATE EVENT BENCHMARKS ===");
    const eventCount = 1000;
    const lateTolerance = [0, 5000, 15000, 30000]; // 0s, 5s, 15s, 30s
    for (const tolerance of lateTolerance) {
      const engine = new correlation_engine_1.CorrelationEngine({
        timeWindow: 30000,
        lateTolerance: tolerance,
        joinType: "inner",
        maxEvents: 10000,
      });
      // Generate events with some arriving late
      const source1Events = this.generateEvents(eventCount, "source_0");
      const source2Events = this.generateEvents(
        eventCount,
        "source_1",
        new Date(Date.now() + tolerance + 1000)
      ); // Make some events late
      const adapters = new Map([
        ["source_0", new MockAdapter("source_0", source1Events)],
        ["source_1", new MockAdapter("source_1", source2Events)],
      ]);
      const query = `source_0({}) and on(request_id) source_1({})`;
      const result = await this.runBenchmark(
        `Late Tolerance ${tolerance}ms - ${eventCount} events`,
        engine,
        query,
        adapters
      );
      this.results.push(result);
      this.printResult(result);
    }
  }
  /**
   * Stress test with high-frequency events
   */
  async stressTest() {
    console.log("\n=== STRESS TEST ===");
    const eventCount = 50000;
    const engine = new correlation_engine_1.CorrelationEngine({
      timeWindow: 120000, // 2 minutes
      joinType: "inner",
      maxEvents: eventCount * 2,
      bufferSize: 10000,
      maxMemoryMB: 1024, // 1 GB limit
    });
    // Generate high-frequency events with many correlations
    const sources = this.generateCorrelatedEvents(eventCount, 3);
    const adapters = new Map();
    for (const [sourceName, events] of sources) {
      adapters.set(sourceName, new MockAdapter(sourceName, events));
    }
    const query = `source_0({}) and on(request_id) source_1({}) and on(request_id) source_2({})`;
    const result = await this.runBenchmark(
      `Stress Test - ${eventCount} events × 3 sources`,
      engine,
      query,
      adapters
    );
    this.results.push(result);
    this.printResult(result);
  }
  /**
   * Print benchmark result
   */
  printResult(result) {
    console.log(`\n${result.name}:`);
    console.log(`  Duration: ${result.duration.toFixed(2)}ms`);
    console.log(
      `  Events Processed: ${result.eventsProcessed.toLocaleString()}`
    );
    console.log(
      `  Correlations Found: ${result.correlationsFound.toLocaleString()}`
    );
    console.log(`  Throughput: ${result.throughput.toFixed(2)} events/sec`);
    console.log(`  Memory Usage:`);
    console.log(
      `    Heap Used: ${(result.memoryUsage.heapUsed / 1024 / 1024).toFixed(
        2
      )} MB`
    );
    console.log(
      `    Heap Total: ${(result.memoryUsage.heapTotal / 1024 / 1024).toFixed(
        2
      )} MB`
    );
    console.log(
      `    RSS: ${(result.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`
    );
  }
  /**
   * Generate comprehensive benchmark report
   */
  generateReport() {
    console.log("\n=== BENCHMARK SUMMARY REPORT ===");
    if (this.results.length === 0) {
      console.log("No benchmark results available.");
      return;
    }
    // Performance statistics
    const throughputs = this.results.map((r) => r.throughput);
    const durations = this.results.map((r) => r.duration);
    const memoryUsages = this.results.map(
      (r) => r.memoryUsage.heapUsed / 1024 / 1024
    );
    console.log("\nPerformance Statistics:");
    console.log(
      `  Average Throughput: ${(
        throughputs.reduce((a, b) => a + b, 0) / throughputs.length
      ).toFixed(2)} events/sec`
    );
    console.log(
      `  Max Throughput: ${Math.max(...throughputs).toFixed(2)} events/sec`
    );
    console.log(
      `  Min Throughput: ${Math.min(...throughputs).toFixed(2)} events/sec`
    );
    console.log(
      `\n  Average Duration: ${(
        durations.reduce((a, b) => a + b, 0) / durations.length
      ).toFixed(2)}ms`
    );
    console.log(`  Max Duration: ${Math.max(...durations).toFixed(2)}ms`);
    console.log(`  Min Duration: ${Math.min(...durations).toFixed(2)}ms`);
    console.log(
      `\n  Average Memory Usage: ${(
        memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length
      ).toFixed(2)} MB`
    );
    console.log(
      `  Max Memory Usage: ${Math.max(...memoryUsages).toFixed(2)} MB`
    );
    console.log(
      `  Min Memory Usage: ${Math.min(...memoryUsages).toFixed(2)} MB`
    );
    // Top performers
    const topThroughput = this.results.reduce((max, result) =>
      result.throughput > max.throughput ? result : max
    );
    const lowestMemory = this.results.reduce((min, result) =>
      result.memoryUsage.heapUsed < min.memoryUsage.heapUsed ? result : min
    );
    console.log("\nTop Performers:");
    console.log(
      `  Highest Throughput: ${
        topThroughput.name
      } (${topThroughput.throughput.toFixed(2)} events/sec)`
    );
    console.log(
      `  Lowest Memory Usage: ${lowestMemory.name} (${(
        lowestMemory.memoryUsage.heapUsed /
        1024 /
        1024
      ).toFixed(2)} MB)`
    );
    // Recommendations
    console.log("\nRecommendations:");
    const avgThroughput =
      throughputs.reduce((a, b) => a + b, 0) / throughputs.length;
    if (avgThroughput < 1000) {
      console.log(
        `  - Consider optimizing correlation algorithms (current avg: ${avgThroughput.toFixed(
          2
        )} events/sec)`
      );
    }
    const avgMemory =
      memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length;
    if (avgMemory > 100) {
      console.log(
        `  - Consider reducing buffer sizes or implementing memory optimization (current avg: ${avgMemory.toFixed(
          2
        )} MB)`
      );
    }
    const highDurationResults = this.results.filter((r) => r.duration > 1000);
    if (highDurationResults.length > 0) {
      console.log(
        `  - ${highDurationResults.length} tests took over 1 second - consider performance optimization`
      );
    }
  }
  /**
   * Export results to JSON
   */
  exportResults(filename = "benchmark-results.json") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      results: this.results,
    };
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log(`\nBenchmark results exported to ${filename}`);
  }
  /**
   * Run all benchmarks
   */
  async runAllBenchmarks(options = {}) {
    console.log("Starting Performance Benchmark Suite...");
    console.log(`Node.js Version: ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
    try {
      await this.benchmarkJoinTypes(options);
      await this.benchmarkDataVolumes(options);
      await this.benchmarkTimeWindows(options);
      await this.benchmarkMultiStream(options);
      await this.benchmarkMemoryUsage();
      await this.benchmarkLateEvents();
      await this.stressTest();
      this.generateReport();
      this.exportResults();
    } catch (error) {
      console.error("Benchmark suite failed:", error);
    }
  }
}
exports.PerformanceBenchmark = PerformanceBenchmark;
// Allow running benchmarks directly
if (require.main === module) {
  const benchmark = new PerformanceBenchmark();
  benchmark
    .runAllBenchmarks({
      warmupRuns: 3,
      benchmarkRuns: 5,
      eventCounts: [100, 500, 1000, 2500, 5000],
      timeWindows: ["5s", "30s", "1m", "5m"],
      joinTypes: ["inner", "left", "outer"],
    })
    .catch(console.error);
}
//# sourceMappingURL=performance.bench.js.map
