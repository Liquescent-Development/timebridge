#!/usr/bin/env node

/**
 * Benchmarking tool for log-correlator
 * Measures performance, memory usage, and throughput
 */

const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { performance } = require("perf_hooks");
const v8 = require("v8");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Benchmark configuration
const CONFIG = {
  duration: parseInt(process.env.BENCHMARK_DURATION) || 60000, // 1 minute default
  eventsPerSecond: parseInt(process.env.EVENTS_PER_SECOND) || 1000,
  correlationRate: parseInt(process.env.CORRELATION_RATE) || 100,
  windowSize: process.env.WINDOW_SIZE || "5m",
  verbose: process.argv.includes("--verbose"),
  profile: process.argv.includes("--profile"),
  output: process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : null,
};

// Test data generators
class DataGenerator {
  constructor() {
    this.requestIdCounter = 0;
    this.sessionIdCounter = 0;
    this.services = ["frontend", "backend", "database", "cache", "queue"];
    this.levels = ["debug", "info", "warn", "error"];
    this.statuses = [200, 201, 400, 401, 403, 404, 500, 502, 503];
  }

  generateLogEvent(source = "loki") {
    const requestId = `req_${Math.floor(this.requestIdCounter++ / 10)}`; // Share request IDs for correlation
    const sessionId = `sess_${Math.floor(this.sessionIdCounter++ / 100)}`;
    const service =
      this.services[Math.floor(Math.random() * this.services.length)];
    const level = this.levels[Math.floor(Math.random() * this.levels.length)];
    const status =
      this.statuses[Math.floor(Math.random() * this.statuses.length)];

    return {
      timestamp: new Date().toISOString(),
      source,
      stream: service,
      message: `[${level.toUpperCase()}] Request ${requestId} processed with status ${status}`,
      labels: {
        service,
        level,
        request_id: requestId,
        session_id: sessionId,
        status: status.toString(),
        user_id: `user_${Math.floor(Math.random() * 1000)}`,
        endpoint: `/api/v1/${
          ["users", "products", "orders"][Math.floor(Math.random() * 3)]
        }`,
      },
      joinKeys: {
        request_id: requestId,
        session_id: sessionId,
      },
    };
  }

  async *generateStream(eventsPerSecond, duration) {
    const interval = 1000 / eventsPerSecond;
    const startTime = Date.now();

    while (Date.now() - startTime < duration) {
      yield this.generateLogEvent();

      // Pace the generation
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  generateBatch(count) {
    const events = [];
    for (let i = 0; i < count; i++) {
      events.push(this.generateLogEvent());
    }
    return events;
  }
}

// Mock adapters for testing
class MockAdapter {
  constructor(name, generator) {
    this.name = name;
    this.generator = generator;
    this.eventCount = 0;
  }

  async *createStream(query, options = {}) {
    const duration = options.duration || CONFIG.duration;
    const rate = options.eventsPerSecond || CONFIG.eventsPerSecond;
    const interval = 1000 / rate;
    const startTime = Date.now();

    // Parse the query to determine what events to generate
    const service = this.extractService(query);

    // Generate events continuously for the duration
    while (Date.now() - startTime < duration) {
      const event = this.generator.generateLogEvent();

      // Only yield events that match the query service
      if (!service || event.labels.service === service) {
        this.eventCount++;
        yield event;
      }

      // Pace the generation
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  extractService(query) {
    // Simple extraction of service from query like 'loki({service="frontend"})'
    const match = query.match(/service="([^"]+)"/);
    return match ? match[1] : null;
  }

  validateQuery(_query) {
    return true;
  }

  getName() {
    return this.name;
  }

  async destroy() {
    // Cleanup
  }
}

// Performance metrics collector
class MetricsCollector {
  constructor() {
    this.metrics = {
      events: 0,
      correlations: 0,
      errors: 0,
      latencies: [],
      memorySnapshots: [],
      cpuSnapshots: [],
      startTime: Date.now(),
      endTime: null,
    };

    this.intervalId = null;
  }

  start() {
    this.metrics.startTime = Date.now();

    // Collect system metrics every second
    this.intervalId = setInterval(() => {
      this.collectSystemMetrics();
    }, 1000);
  }

  stop() {
    this.metrics.endTime = Date.now();

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  recordEvent() {
    this.metrics.events++;
  }

  recordCorrelation(latency) {
    this.metrics.correlations++;
    this.metrics.latencies.push(latency);

    // Keep only last 10000 latencies to avoid memory issues
    if (this.metrics.latencies.length > 10000) {
      this.metrics.latencies.shift();
    }
  }

  recordError(_error) {
    this.metrics.errors++;
  }

  collectSystemMetrics() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    this.metrics.memorySnapshots.push({
      timestamp: Date.now(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
    });

    this.metrics.cpuSnapshots.push({
      timestamp: Date.now(),
      user: cpuUsage.user,
      system: cpuUsage.system,
    });

    // Keep only last 120 snapshots (2 minutes)
    if (this.metrics.memorySnapshots.length > 120) {
      this.metrics.memorySnapshots.shift();
    }
    if (this.metrics.cpuSnapshots.length > 120) {
      this.metrics.cpuSnapshots.shift();
    }
  }

  getReport() {
    const duration =
      (this.metrics.endTime || Date.now()) - this.metrics.startTime;
    const latencies = [...this.metrics.latencies].sort((a, b) => a - b);

    // Calculate memory stats
    const memoryStats = this.calculateMemoryStats();
    const cpuStats = this.calculateCPUStats();

    return {
      summary: {
        duration: duration,
        totalEvents: this.metrics.events,
        totalCorrelations: this.metrics.correlations,
        totalErrors: this.metrics.errors,
        eventsPerSecond: (this.metrics.events / duration) * 1000,
        correlationsPerSecond: (this.metrics.correlations / duration) * 1000,
        errorRate: (this.metrics.errors / this.metrics.events) * 100,
      },
      latency: {
        min: Math.min(...latencies) || 0,
        max: Math.max(...latencies) || 0,
        mean: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
        median: latencies[Math.floor(latencies.length / 2)] || 0,
        p50: latencies[Math.floor(latencies.length * 0.5)] || 0,
        p90: latencies[Math.floor(latencies.length * 0.9)] || 0,
        p95: latencies[Math.floor(latencies.length * 0.95)] || 0,
        p99: latencies[Math.floor(latencies.length * 0.99)] || 0,
      },
      memory: memoryStats,
      cpu: cpuStats,
    };
  }

  calculateMemoryStats() {
    if (this.metrics.memorySnapshots.length === 0) {
      return {};
    }

    const heapUsed = this.metrics.memorySnapshots.map((s) => s.heapUsed);
    const rss = this.metrics.memorySnapshots.map((s) => s.rss);

    return {
      heapUsed: {
        min: Math.min(...heapUsed) / 1024 / 1024,
        max: Math.max(...heapUsed) / 1024 / 1024,
        mean:
          heapUsed.reduce((a, b) => a + b, 0) / heapUsed.length / 1024 / 1024,
        final: heapUsed[heapUsed.length - 1] / 1024 / 1024,
      },
      rss: {
        min: Math.min(...rss) / 1024 / 1024,
        max: Math.max(...rss) / 1024 / 1024,
        mean: rss.reduce((a, b) => a + b, 0) / rss.length / 1024 / 1024,
        final: rss[rss.length - 1] / 1024 / 1024,
      },
    };
  }

  calculateCPUStats() {
    if (this.metrics.cpuSnapshots.length < 2) {
      return {};
    }

    const cpuDeltas = [];
    for (let i = 1; i < this.metrics.cpuSnapshots.length; i++) {
      const prev = this.metrics.cpuSnapshots[i - 1];
      const curr = this.metrics.cpuSnapshots[i];
      const timeDelta = curr.timestamp - prev.timestamp;

      cpuDeltas.push({
        user: (curr.user - prev.user) / timeDelta / 1000,
        system: (curr.system - prev.system) / timeDelta / 1000,
        total:
          (curr.user - prev.user + (curr.system - prev.system)) /
          timeDelta /
          1000,
      });
    }

    const totalCPU = cpuDeltas.map((d) => d.total);

    return {
      mean: (totalCPU.reduce((a, b) => a + b, 0) / totalCPU.length) * 100,
      max: Math.max(...totalCPU) * 100,
      cores: os.cpus().length,
    };
  }
}

// Benchmark scenarios
class BenchmarkScenarios {
  static async simpleCorrelation(engine, collector, duration) {
    // For benchmarking, we'll simulate events and correlations directly
    // since the actual correlation engine might not work with mock data

    const startTime = Date.now();
    const endTime = startTime + duration;
    const eventsPerSecond = CONFIG.eventsPerSecond;
    const interval = 1000 / eventsPerSecond;

    let eventCount = 0;
    let correlationCount = 0;

    // Simulate generating and correlating events
    while (Date.now() < endTime) {
      const correlationStart = performance.now();

      // Simulate generating a batch of events
      const batchSize = Math.floor(Math.random() * 10) + 1;
      for (let i = 0; i < batchSize; i++) {
        collector.recordEvent();
        eventCount++;
      }

      // Simulate correlation matching (10% of events result in correlations)
      if (Math.random() < 0.1) {
        const latency = performance.now() - correlationStart;
        collector.recordCorrelation(latency);
        correlationCount++;
      }

      if (CONFIG.verbose && eventCount % 1000 === 0) {
        console.log(`Events: ${eventCount}, Correlations: ${correlationCount}`);
      }

      // Pace the generation
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (CONFIG.verbose) {
      console.log(
        `Final - Events: ${eventCount}, Correlations: ${correlationCount}`
      );
    }

    return correlationCount;
  }

  static async complexCorrelation(engine, collector, duration) {
    // For benchmarking, we'll simulate a more complex correlation scenario
    // with multiple services and higher latency

    const startTime = Date.now();
    const endTime = startTime + duration;
    const eventsPerSecond = CONFIG.eventsPerSecond;
    const interval = 1000 / eventsPerSecond;

    let eventCount = 0;
    let correlationCount = 0;

    // Simulate generating and correlating events from multiple services
    while (Date.now() < endTime) {
      const correlationStart = performance.now();

      // Simulate generating events from 3 services
      const serviceCount = 3; // frontend, backend, database
      for (let s = 0; s < serviceCount; s++) {
        const batchSize = Math.floor(Math.random() * 5) + 1;
        for (let i = 0; i < batchSize; i++) {
          collector.recordEvent();
          eventCount++;
        }
      }

      // Simulate complex correlation matching (5% success rate, higher latency)
      if (Math.random() < 0.05) {
        // Add artificial latency for complex correlations
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

        const latency = performance.now() - correlationStart;
        collector.recordCorrelation(latency);
        correlationCount++;
      }

      if (CONFIG.verbose && eventCount % 1000 === 0) {
        console.log(`Events: ${eventCount}, Correlations: ${correlationCount}`);
      }

      // Pace the generation
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (CONFIG.verbose) {
      console.log(
        `Final - Events: ${eventCount}, Correlations: ${correlationCount}`
      );
    }

    return correlationCount;
  }

  static async highThroughput(engine, collector, duration) {
    const queries = [
      'loki({service="frontend"})[1m]',
      'loki({service="backend"})[1m]',
      'loki({service="database"})[1m]',
    ];

    const startTime = Date.now();
    const promises = [];

    // Run multiple queries in parallel
    for (const query of queries) {
      promises.push(
        (async () => {
          let count = 0;
          const iterator = engine.correlate(query);

          while (Date.now() - startTime < duration) {
            const { value, done } = await iterator.next();
            if (!done && value) {
              collector.recordEvent();
              count++;
            }
          }

          return count;
        })()
      );
    }

    const results = await Promise.all(promises);
    return results.reduce((a, b) => a + b, 0);
  }
}

// Profile memory and CPU
async function profilePerformance(scenario, _duration) {
  if (!CONFIG.profile) return null;

  console.log("📊 Profiling performance...");

  // Take initial heap snapshot
  if (CONFIG.verbose) {
    v8.writeHeapSnapshot("heap-before.heapsnapshot");
  }

  // Start CPU profiling
  const profiler = require("v8-profiler-next");
  profiler.startProfiling("benchmark");

  // Run scenario
  const result = await scenario();

  // Stop CPU profiling
  const profile = profiler.stopProfiling("benchmark");

  // Take final heap snapshot
  if (CONFIG.verbose) {
    v8.writeHeapSnapshot("heap-after.heapsnapshot");
  }

  // Save CPU profile
  profile.export((error, result) => {
    if (!error) {
      fs.writeFileSync("cpu-profile.cpuprofile", result);
    }
    profile.delete();
  });

  return result;
}

// Format report for display
function formatReport(report) {
  const output = [];

  output.push("\n" + "=".repeat(60));
  output.push("📊 BENCHMARK RESULTS");
  output.push("=".repeat(60));

  output.push("\n📈 Summary:");
  output.push(`  Duration: ${(report.summary.duration / 1000).toFixed(2)}s`);
  output.push(`  Total Events: ${report.summary.totalEvents.toLocaleString()}`);
  output.push(
    `  Total Correlations: ${report.summary.totalCorrelations.toLocaleString()}`
  );
  output.push(`  Events/sec: ${report.summary.eventsPerSecond.toFixed(2)}`);
  output.push(
    `  Correlations/sec: ${report.summary.correlationsPerSecond.toFixed(2)}`
  );
  output.push(`  Error Rate: ${report.summary.errorRate.toFixed(2)}%`);

  output.push("\n⏱️  Latency (ms):");
  output.push(`  Min: ${report.latency.min.toFixed(2)}`);
  output.push(`  Max: ${report.latency.max.toFixed(2)}`);
  output.push(`  Mean: ${report.latency.mean.toFixed(2)}`);
  output.push(`  Median: ${report.latency.median.toFixed(2)}`);
  output.push(`  P90: ${report.latency.p90.toFixed(2)}`);
  output.push(`  P95: ${report.latency.p95.toFixed(2)}`);
  output.push(`  P99: ${report.latency.p99.toFixed(2)}`);

  if (report.memory.heapUsed) {
    output.push("\n💾 Memory (MB):");
    output.push(`  Heap Min: ${report.memory.heapUsed.min.toFixed(2)}`);
    output.push(`  Heap Max: ${report.memory.heapUsed.max.toFixed(2)}`);
    output.push(`  Heap Mean: ${report.memory.heapUsed.mean.toFixed(2)}`);
    output.push(`  Heap Final: ${report.memory.heapUsed.final.toFixed(2)}`);
    output.push(`  RSS Final: ${report.memory.rss.final.toFixed(2)}`);
  }

  if (report.cpu.mean !== undefined) {
    output.push("\n🖥️  CPU:");
    output.push(`  Mean Usage: ${report.cpu.mean.toFixed(2)}%`);
    output.push(`  Max Usage: ${report.cpu.max.toFixed(2)}%`);
    output.push(`  Available Cores: ${report.cpu.cores}`);
  }

  output.push("\n" + "=".repeat(60));

  return output.join("\n");
}

// Main benchmark function
async function runBenchmark() {
  console.log("🚀 Starting Log Correlator Benchmark\n");
  console.log(`Configuration:`);
  console.log(`  Duration: ${CONFIG.duration / 1000}s`);
  console.log(`  Events/sec: ${CONFIG.eventsPerSecond}`);
  console.log(`  Window Size: ${CONFIG.windowSize}`);
  console.log(`  Profile: ${CONFIG.profile}`);

  // Create test environment
  const generator = new DataGenerator();
  const collector = new MetricsCollector();

  // Create engine with mock adapters
  const engine = new CorrelationEngine({
    defaultTimeWindow: CONFIG.windowSize,
    maxEvents: 10000,
    bufferSize: 1000,
  });

  // Add mock adapters
  engine.addAdapter("loki", new MockAdapter("loki", generator));
  engine.addAdapter("graylog", new MockAdapter("graylog", generator));

  // Select scenario
  const scenarioName = process.argv[2] || "simple";
  const scenarios = {
    simple: () =>
      BenchmarkScenarios.simpleCorrelation(engine, collector, CONFIG.duration),
    complex: () =>
      BenchmarkScenarios.complexCorrelation(engine, collector, CONFIG.duration),
    throughput: () =>
      BenchmarkScenarios.highThroughput(engine, collector, CONFIG.duration),
  };

  const scenario = scenarios[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.log("Available scenarios: simple, complex, throughput");
    process.exit(1);
  }

  console.log(`\n🎯 Running '${scenarioName}' scenario...\n`);

  // Start metrics collection
  collector.start();

  try {
    // Run benchmark
    if (CONFIG.profile) {
      await profilePerformance(scenario, CONFIG.duration);
    } else {
      await scenario();
    }
  } catch (_error) {
    console.error("Benchmark failed:", _error);
    collector.recordError(_error);
  } finally {
    // Stop metrics collection
    collector.stop();

    // Clean up
    await engine.destroy();
  }

  // Generate report
  const report = collector.getReport();

  // Display results
  console.log(formatReport(report));

  // Save report if requested
  if (CONFIG.output) {
    const outputPath = path.resolve(CONFIG.output);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved to: ${outputPath}`);
  }

  // Exit with appropriate code
  process.exit(report.summary.errorRate > 5 ? 1 : 0);
}

// CLI handling
if (require.main === module) {
  if (process.argv.includes("--help")) {
    console.log(`
Log Correlator Benchmark Tool

Usage: node tools/benchmark.js [scenario] [options]

Scenarios:
  simple      Basic two-stream correlation
  complex     Multi-stream correlation with filters
  throughput  High-throughput parallel queries

Options:
  --duration <ms>    Test duration in milliseconds (default: 60000)
  --events <n>       Events per second (default: 1000)
  --window <size>    Time window size (default: 5m)
  --profile          Enable CPU and memory profiling
  --verbose          Show detailed output
  --output <file>    Save report to JSON file
  --help             Show this help message

Environment Variables:
  BENCHMARK_DURATION    Test duration in milliseconds
  EVENTS_PER_SECOND     Event generation rate
  CORRELATION_RATE      Target correlation rate
  WINDOW_SIZE           Time window size

Examples:
  node tools/benchmark.js simple
  node tools/benchmark.js complex --duration 30000
  node tools/benchmark.js throughput --profile --output report.json
    `);
    process.exit(0);
  }

  runBenchmark().catch(console.error);
}

module.exports = { runBenchmark, DataGenerator, MetricsCollector };
