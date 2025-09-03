#!/usr/bin/env node

/**
 * Load testing tool for log-correlator
 * Simulates real-world load patterns and stress tests
 */

const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const cluster = require("cluster");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Load test configuration
const CONFIG = {
  workers: parseInt(process.env.LOAD_TEST_WORKERS) || os.cpus().length,
  duration: parseInt(process.env.LOAD_TEST_DURATION) || 300000, // 5 minutes
  rampUp: parseInt(process.env.RAMP_UP_TIME) || 30000, // 30 seconds
  targetRPS: parseInt(process.env.TARGET_RPS) || 1000,
  scenario: process.env.SCENARIO || "mixed",
  verbose: process.argv.includes("--verbose"),
  report: process.argv.includes("--report"),
};

// Load patterns
const LOAD_PATTERNS = {
  steady: (t, duration, targetRPS) => targetRPS,

  ramp: (t, duration, targetRPS) => {
    const rampDuration = duration * 0.2; // 20% ramp up
    if (t < rampDuration) {
      return (t / rampDuration) * targetRPS;
    }
    return targetRPS;
  },

  spike: (t, duration, targetRPS) => {
    const phase = (t / duration) * 10;
    if (Math.floor(phase) % 3 === 0) {
      return targetRPS * 2; // Spike every 3rd phase
    }
    return targetRPS;
  },

  wave: (t, duration, targetRPS) => {
    const frequency = 0.001; // Wave frequency
    return targetRPS * (1 + 0.5 * Math.sin(2 * Math.PI * frequency * t));
  },

  stress: (t, duration, targetRPS) => {
    // Exponentially increase load
    return targetRPS * Math.pow(2, t / duration);
  },
};

// Test scenarios
const SCENARIOS = {
  simple: {
    queries: [
      'loki({service="frontend"})[5m] and on(request_id) loki({service="backend"})[5m]',
    ],
    distribution: [1.0],
  },

  mixed: {
    queries: [
      'loki({service="frontend"})[5m]',
      'loki({service="frontend"})[5m] and on(request_id) loki({service="backend"})[5m]',
      'loki({job="nginx"})[5m] and on(request_id) graylog(service:api)[5m]',
      'loki({service="frontend", level="error"})[5m] and on(request_id) within(30s) loki({service="backend"})[5m]',
    ],
    distribution: [0.3, 0.4, 0.2, 0.1],
  },

  complex: {
    queries: [
      'loki({service="frontend"})[10m] and on(request_id) within(30s) loki({service="backend"})[10m] and on(request_id) loki({service="database"})[10m]',
      'loki({service="frontend", level="error"})[5m] and on(request_id) group_left(session_id) loki({service="backend"})[5m]',
      'loki({job="nginx"})[5m] and on(session_id=trace_id) graylog(service:backend)[5m]',
    ],
    distribution: [0.5, 0.3, 0.2],
  },

  stress: {
    queries: [
      'loki({service="frontend"})[30m] and on(request_id) loki({service="backend"})[30m]',
      'loki({service="frontend"})[1h] and on(request_id, session_id, user_id) loki({service="backend"})[1h]',
    ],
    distribution: [0.7, 0.3],
  },
};

// Worker process logic
class LoadWorker {
  constructor(workerId, config) {
    this.workerId = workerId;
    this.config = config;
    this.stats = {
      requests: 0,
      successes: 0,
      failures: 0,
      latencies: [],
      errors: {},
    };

    this.engine = null;
    this.running = false;
  }

  async initialize() {
    // Create engine with realistic configuration
    this.engine = new CorrelationEngine({
      defaultTimeWindow: "5m",
      maxEvents: 5000,
      bufferSize: 500,
      maxMemoryMB: 100,
    });

    // Add mock adapters
    const { MockAdapter, DataGenerator } = require("./benchmark");
    const generator = new DataGenerator();

    this.engine.addAdapter("loki", new MockAdapter("loki", generator));
    this.engine.addAdapter("graylog", new MockAdapter("graylog", generator));
  }

  selectQuery() {
    const scenario = SCENARIOS[this.config.scenario];
    const random = Math.random();
    let cumulative = 0;

    for (let i = 0; i < scenario.queries.length; i++) {
      cumulative += scenario.distribution[i];
      if (random <= cumulative) {
        return scenario.queries[i];
      }
    }

    return scenario.queries[0];
  }

  async executeQuery() {
    const query = this.selectQuery();
    const startTime = Date.now();

    this.stats.requests++;

    try {
      let correlationCount = 0;
      const timeout = setTimeout(() => {
        throw new Error("Query timeout");
      }, 30000); // 30 second timeout

      for await (const correlation of this.engine.correlate(query)) {
        if (correlation) correlationCount++;
        if (correlationCount >= 100) break; // Limit results
      }

      clearTimeout(timeout);

      const latency = Date.now() - startTime;
      this.stats.successes++;
      this.stats.latencies.push(latency);

      // Keep only last 1000 latencies
      if (this.stats.latencies.length > 1000) {
        this.stats.latencies.shift();
      }

      return { success: true, latency, correlations: correlationCount };
    } catch (error) {
      this.stats.failures++;
      const errorType = error.message || "Unknown error";
      this.stats.errors[errorType] = (this.stats.errors[errorType] || 0) + 1;

      return { success: false, error: errorType };
    }
  }

  async run() {
    await this.initialize();

    this.running = true;
    const startTime = Date.now();

    while (this.running && Date.now() - startTime < this.config.duration) {
      const elapsed = Date.now() - startTime;
      const pattern = LOAD_PATTERNS[this.config.pattern || "steady"];
      const targetRPS = pattern(
        elapsed,
        this.config.duration,
        this.config.targetRPS
      );
      const requestsPerWorker = targetRPS / this.config.workers;
      const delay = 1000 / requestsPerWorker;

      await this.executeQuery();
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Send stats periodically
      if (this.stats.requests % 100 === 0) {
        process.send({
          type: "stats",
          workerId: this.workerId,
          stats: this.getStats(),
        });
      }
    }

    // Send final stats
    process.send({
      type: "complete",
      workerId: this.workerId,
      stats: this.getStats(),
    });

    await this.cleanup();
  }

  getStats() {
    const latencies = [...this.stats.latencies].sort((a, b) => a - b);

    return {
      requests: this.stats.requests,
      successes: this.stats.successes,
      failures: this.stats.failures,
      successRate: (this.stats.successes / this.stats.requests) * 100 || 0,
      latency: {
        min: Math.min(...latencies) || 0,
        max: Math.max(...latencies) || 0,
        mean: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
        p50: latencies[Math.floor(latencies.length * 0.5)] || 0,
        p90: latencies[Math.floor(latencies.length * 0.9)] || 0,
        p95: latencies[Math.floor(latencies.length * 0.95)] || 0,
        p99: latencies[Math.floor(latencies.length * 0.99)] || 0,
      },
      errors: this.stats.errors,
    };
  }

  stop() {
    this.running = false;
  }

  async cleanup() {
    if (this.engine) {
      await this.engine.destroy();
    }
  }
}

// Master process coordinator
class LoadCoordinator {
  constructor(config) {
    this.config = config;
    this.workers = [];
    this.stats = new Map();
    this.startTime = null;
    this.intervalId = null;
  }

  async start() {
    console.log("🚀 Starting Load Test");
    console.log(`  Workers: ${this.config.workers}`);
    console.log(`  Duration: ${this.config.duration / 1000}s`);
    console.log(`  Target RPS: ${this.config.targetRPS}`);
    console.log(`  Scenario: ${this.config.scenario}`);
    console.log(`  Pattern: ${this.config.pattern || "steady"}\n`);

    this.startTime = Date.now();

    // Fork workers
    for (let i = 0; i < this.config.workers; i++) {
      const worker = cluster.fork();
      worker.on("message", (msg) => this.handleWorkerMessage(worker.id, msg));
      this.workers.push(worker);
    }

    // Monitor progress
    this.intervalId = setInterval(() => this.printProgress(), 5000);

    // Wait for completion
    await this.waitForCompletion();

    // Generate report
    this.generateReport();
  }

  handleWorkerMessage(workerId, message) {
    if (message.type === "stats" || message.type === "complete") {
      this.stats.set(workerId, message.stats);

      if (message.type === "complete") {
        const worker = this.workers.find((w) => w.id === workerId);
        if (worker) {
          worker.completed = true;
        }
      }
    }
  }

  printProgress() {
    const aggregated = this.aggregateStats();
    const elapsed = (Date.now() - this.startTime) / 1000;

    console.log(
      `[${elapsed.toFixed(0)}s] Requests: ${
        aggregated.requests
      } | Success: ${aggregated.successRate.toFixed(
        1
      )}% | P95: ${aggregated.latency.p95.toFixed(0)}ms`
    );
  }

  async waitForCompletion() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const allCompleted = this.workers.every((w) => w.completed);
        const timeout =
          Date.now() - this.startTime > this.config.duration + 10000;

        if (allCompleted || timeout) {
          clearInterval(checkInterval);
          clearInterval(this.intervalId);
          resolve();
        }
      }, 1000);
    });
  }

  aggregateStats() {
    const allStats = Array.from(this.stats.values());

    if (allStats.length === 0) {
      return {
        requests: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        latency: { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
        errors: {},
      };
    }

    // Aggregate totals
    const totals = allStats.reduce(
      (acc, stats) => ({
        requests: acc.requests + stats.requests,
        successes: acc.successes + stats.successes,
        failures: acc.failures + stats.failures,
      }),
      { requests: 0, successes: 0, failures: 0 }
    );

    // Merge all latencies
    const allLatencies = allStats
      .flatMap((s) =>
        s.latency
          ? [
              s.latency.min,
              s.latency.max,
              s.latency.mean,
              s.latency.p50,
              s.latency.p90,
              s.latency.p95,
              s.latency.p99,
            ]
          : []
      )
      .filter((l) => l > 0)
      .sort((a, b) => a - b);

    // Aggregate errors
    const errors = {};
    allStats.forEach((stats) => {
      Object.entries(stats.errors || {}).forEach(([type, count]) => {
        errors[type] = (errors[type] || 0) + count;
      });
    });

    return {
      requests: totals.requests,
      successes: totals.successes,
      failures: totals.failures,
      successRate: (totals.successes / totals.requests) * 100 || 0,
      latency: {
        min: Math.min(...allLatencies) || 0,
        max: Math.max(...allLatencies) || 0,
        mean:
          allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length || 0,
        p50: allLatencies[Math.floor(allLatencies.length * 0.5)] || 0,
        p90: allLatencies[Math.floor(allLatencies.length * 0.9)] || 0,
        p95: allLatencies[Math.floor(allLatencies.length * 0.95)] || 0,
        p99: allLatencies[Math.floor(allLatencies.length * 0.99)] || 0,
      },
      errors,
    };
  }

  generateReport() {
    const duration = (Date.now() - this.startTime) / 1000;
    const stats = this.aggregateStats();
    const rps = stats.requests / duration;

    console.log("\n" + "=".repeat(60));
    console.log("📊 LOAD TEST RESULTS");
    console.log("=".repeat(60));

    console.log("\n📈 Summary:");
    console.log(`  Test Duration: ${duration.toFixed(1)}s`);
    console.log(`  Total Requests: ${stats.requests.toLocaleString()}`);
    console.log(`  Successful: ${stats.successes.toLocaleString()}`);
    console.log(`  Failed: ${stats.failures.toLocaleString()}`);
    console.log(`  Success Rate: ${stats.successRate.toFixed(2)}%`);
    console.log(`  Requests/sec: ${rps.toFixed(2)}`);

    console.log("\n⏱️  Response Time (ms):");
    console.log(`  Min: ${stats.latency.min.toFixed(0)}`);
    console.log(`  Max: ${stats.latency.max.toFixed(0)}`);
    console.log(`  Mean: ${stats.latency.mean.toFixed(0)}`);
    console.log(`  P50: ${stats.latency.p50.toFixed(0)}`);
    console.log(`  P90: ${stats.latency.p90.toFixed(0)}`);
    console.log(`  P95: ${stats.latency.p95.toFixed(0)}`);
    console.log(`  P99: ${stats.latency.p99.toFixed(0)}`);

    if (Object.keys(stats.errors).length > 0) {
      console.log("\n❌ Errors:");
      Object.entries(stats.errors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([type, count]) => {
          console.log(`  ${type}: ${count}`);
        });
    }

    console.log("\n" + "=".repeat(60));

    // Pass/Fail determination
    const passed = stats.successRate >= 95 && stats.latency.p95 < 1000;

    if (passed) {
      console.log("✅ Load test PASSED");
    } else {
      console.log("❌ Load test FAILED");
      if (stats.successRate < 95) {
        console.log(`  - Success rate ${stats.successRate.toFixed(1)}% < 95%`);
      }
      if (stats.latency.p95 >= 1000) {
        console.log(
          `  - P95 latency ${stats.latency.p95.toFixed(0)}ms >= 1000ms`
        );
      }
    }

    // Save detailed report if requested
    if (this.config.report) {
      const reportPath = path.join(
        process.cwd(),
        `load-test-${Date.now()}.json`
      );
      const report = {
        config: this.config,
        duration,
        stats,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\n📄 Detailed report saved to: ${reportPath}`);
    }

    process.exit(passed ? 0 : 1);
  }
}

// Main entry point
async function main() {
  if (cluster.isMaster) {
    // Master process
    const coordinator = new LoadCoordinator(CONFIG);
    await coordinator.start();
  } else {
    // Worker process
    const worker = new LoadWorker(cluster.worker.id, CONFIG);
    await worker.run();
  }
}

// CLI handling
if (require.main === module) {
  if (process.argv.includes("--help")) {
    console.log(`
Log Correlator Load Test Tool

Usage: node tools/load-test.js [options]

Options:
  --workers <n>      Number of worker processes (default: CPU cores)
  --duration <ms>    Test duration in milliseconds (default: 300000)
  --rps <n>          Target requests per second (default: 1000)
  --scenario <name>  Test scenario: simple, mixed, complex, stress
  --pattern <name>   Load pattern: steady, ramp, spike, wave, stress
  --verbose          Show detailed output
  --report           Save detailed JSON report
  --help             Show this help message

Environment Variables:
  LOAD_TEST_WORKERS   Number of worker processes
  LOAD_TEST_DURATION  Test duration in milliseconds
  TARGET_RPS          Target requests per second
  SCENARIO            Test scenario name

Examples:
  node tools/load-test.js
  node tools/load-test.js --workers 4 --rps 500
  node tools/load-test.js --scenario stress --pattern spike
  node tools/load-test.js --duration 60000 --report
    `);
    process.exit(0);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workers":
        CONFIG.workers = parseInt(args[++i]);
        break;
      case "--duration":
        CONFIG.duration = parseInt(args[++i]);
        break;
      case "--rps":
        CONFIG.targetRPS = parseInt(args[++i]);
        break;
      case "--scenario":
        CONFIG.scenario = args[++i];
        break;
      case "--pattern":
        CONFIG.pattern = args[++i];
        break;
    }
  }

  main().catch(console.error);
}

module.exports = { LoadWorker, LoadCoordinator, SCENARIOS, LOAD_PATTERNS };
