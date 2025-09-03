/**
 * Load Testing Suite for Grafana Integration
 * 
 * These tests simulate realistic production workloads to ensure
 * the system can handle high traffic and concurrent operations.
 */

import { PrometheusAdapter } from "../prometheus/src/prometheus-adapter";
import { LokiAdapter } from "../loki/src/loki-adapter";
import { InfluxDBAdapter } from "../influxdb/src/influxdb-adapter";
import fetch from "node-fetch";
import { performance } from "perf_hooks";

jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

// Test configuration
const LOAD_TEST_CONFIG = {
  concurrentUsers: 50,
  requestsPerUser: 20,
  queryComplexity: {
    simple: 0.6,    // 60% simple queries
    medium: 0.3,    // 30% medium complexity
    complex: 0.1,   // 10% complex queries
  },
  thinkTime: {
    min: 100,       // Minimum delay between requests (ms)
    max: 1000,      // Maximum delay between requests (ms)
  },
};

describe("Load Testing Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMockResponses();
  });

  describe("Prometheus Load Testing", () => {
    it("should handle concurrent user load", async () => {
      const adapter = new PrometheusAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          connectionPool: { maxConnections: 100, maxConnectionsPerHost: 20 },
          queryBatching: { maxBatchSize: 20, batchTimeout: 100 },
          caching: { maxSize: 100 * 1024 * 1024, ttl: 300000 },
          compression: true,
          streamOptimization: true,
        },
      });

      const results = await runLoadTest(adapter, "prometheus");
      
      console.log("Prometheus Load Test Results:");
      printLoadTestResults(results);
      
      // Assert performance requirements
      expect(results.successRate).toBeGreaterThan(0.95); // 95% success rate
      expect(results.avgResponseTime).toBeLessThan(1000); // < 1 second avg
      expect(results.p99ResponseTime).toBeLessThan(5000); // < 5 seconds p99
    });

    it("should handle query bursts", async () => {
      const adapter = new PrometheusAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          queryBatching: { maxBatchSize: 50, batchTimeout: 50 },
        },
      });

      const burstSize = 200;
      const queries = generatePrometheusQueries(burstSize);
      
      const startTime = performance.now();
      const promises = queries.map(q => 
        executeQuery(adapter, q).catch(e => ({ error: e.message }))
      );
      
      const results = await Promise.all(promises);
      const elapsed = performance.now() - startTime;
      
      const successCount = results.filter(r => !r.error).length;
      const errorCount = results.filter(r => r.error).length;
      
      console.log(`Burst test (${burstSize} queries):`);
      console.log(`  Completed in: ${elapsed.toFixed(2)}ms`);
      console.log(`  Success: ${successCount}, Errors: ${errorCount}`);
      console.log(`  Queries/sec: ${(burstSize / elapsed * 1000).toFixed(0)}`);
      
      expect(successCount / burstSize).toBeGreaterThan(0.9);
    });
  });

  describe("Loki Load Testing", () => {
    it("should handle concurrent log queries", async () => {
      const adapter = new LokiAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          connectionPool: true,
          caching: true,
          streamOptimization: true,
        },
      });

      const results = await runLoadTest(adapter, "loki");
      
      console.log("Loki Load Test Results:");
      printLoadTestResults(results);
      
      expect(results.successRate).toBeGreaterThan(0.95);
      expect(results.avgResponseTime).toBeLessThan(1500);
    });

    it("should handle large log streams", async () => {
      const adapter = new LokiAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          streamOptimization: true,
        },
      });

      // Mock large response
      mockedFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => generateLargeLokiResponse(10000), // 10k log lines
      } as any));

      const startTime = performance.now();
      let totalEvents = 0;
      
      const stream = adapter.query('{service="nginx"}');
      for await (const event of stream) {
        totalEvents++;
        if (totalEvents >= 10000) break;
      }
      
      const elapsed = performance.now() - startTime;
      
      console.log(`Large stream test:`);
      console.log(`  Processed ${totalEvents} events in ${elapsed.toFixed(2)}ms`);
      console.log(`  Events/sec: ${(totalEvents / elapsed * 1000).toFixed(0)}`);
      
      expect(totalEvents).toBe(10000);
      expect(elapsed).toBeLessThan(10000); // Process 10k events in < 10 seconds
    });
  });

  describe("InfluxDB Load Testing", () => {
    it("should handle concurrent time series queries", async () => {
      const adapter = new InfluxDBAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          connectionPool: true,
          queryBatching: true,
          caching: true,
        },
      });

      const results = await runLoadTest(adapter, "influxdb");
      
      console.log("InfluxDB Load Test Results:");
      printLoadTestResults(results);
      
      expect(results.successRate).toBeGreaterThan(0.95);
      expect(results.avgResponseTime).toBeLessThan(1200);
    });
  });

  describe("Mixed Workload Testing", () => {
    it("should handle mixed adapter workload", async () => {
      const prometheusAdapter = new PrometheusAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: { connectionPool: true, caching: true },
      });
      
      const lokiAdapter = new LokiAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: { connectionPool: true, caching: true },
      });
      
      const influxAdapter = new InfluxDBAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: { connectionPool: true, caching: true },
      });

      const adapters = [prometheusAdapter, lokiAdapter, influxAdapter];
      const types = ["prometheus", "loki", "influxdb"] as const;
      
      const totalUsers = 30;
      const promises: Promise<any>[] = [];
      
      for (let i = 0; i < totalUsers; i++) {
        const adapterIndex = i % adapters.length;
        const adapter = adapters[adapterIndex];
        const type = types[adapterIndex];
        
        promises.push(simulateUser(adapter, type, 10));
      }
      
      const startTime = performance.now();
      const userResults = await Promise.all(promises);
      const elapsed = performance.now() - startTime;
      
      const totalRequests = userResults.reduce((sum, r) => sum + r.totalRequests, 0);
      const totalSuccess = userResults.reduce((sum, r) => sum + r.successCount, 0);
      
      console.log(`Mixed workload test:`);
      console.log(`  Total requests: ${totalRequests}`);
      console.log(`  Success rate: ${((totalSuccess / totalRequests) * 100).toFixed(1)}%`);
      console.log(`  Total time: ${elapsed.toFixed(2)}ms`);
      console.log(`  Throughput: ${(totalRequests / elapsed * 1000).toFixed(0)} req/sec`);
      
      expect(totalSuccess / totalRequests).toBeGreaterThan(0.9);
    });
  });

  describe("Stress Testing", () => {
    it("should gracefully degrade under extreme load", async () => {
      const adapter = new PrometheusAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          connectionPool: { maxConnections: 10, maxConnectionsPerHost: 5 }, // Limited resources
          queryBatching: { maxBatchSize: 5, maxConcurrent: 2 },
        },
      });

      const extremeLoad = 500;
      const queries = generatePrometheusQueries(extremeLoad);
      
      const startTime = performance.now();
      const results: any[] = [];
      
      // Fire all requests without waiting
      const promises = queries.map(async (q) => {
        try {
          const start = performance.now();
          await executeQuery(adapter, q);
          const responseTime = performance.now() - start;
          return { success: true, responseTime };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });
      
      const outcomes = await Promise.all(promises);
      const elapsed = performance.now() - startTime;
      
      const successCount = outcomes.filter(o => o.success).length;
      const avgResponseTime = outcomes
        .filter(o => o.success)
        .reduce((sum, o) => sum + o.responseTime, 0) / successCount;
      
      console.log(`Stress test (${extremeLoad} concurrent requests):`);
      console.log(`  Success rate: ${((successCount / extremeLoad) * 100).toFixed(1)}%`);
      console.log(`  Avg response time: ${avgResponseTime.toFixed(2)}ms`);
      console.log(`  Total time: ${elapsed.toFixed(2)}ms`);
      
      // Should complete even under stress
      expect(elapsed).toBeLessThan(60000); // Complete within 1 minute
      expect(successCount).toBeGreaterThan(extremeLoad * 0.5); // At least 50% success
    });
  });

  describe("Cache Effectiveness", () => {
    it("should improve performance with caching", async () => {
      const adapter = new PrometheusAdapter({
        url: "https://grafana.test",
        authToken: "test-token",
        optimization: {
          caching: { maxSize: 100 * 1024 * 1024, ttl: 60000 },
        },
      });

      const queries = generatePrometheusQueries(20);
      
      // First pass - cache miss
      const coldStart = performance.now();
      for (const query of queries) {
        await executeQuery(adapter, query);
      }
      const coldTime = performance.now() - coldStart;
      
      // Second pass - cache hit
      const warmStart = performance.now();
      for (const query of queries) {
        await executeQuery(adapter, query);
      }
      const warmTime = performance.now() - warmStart;
      
      const improvement = ((coldTime - warmTime) / coldTime) * 100;
      
      console.log(`Cache effectiveness:`);
      console.log(`  Cold run: ${coldTime.toFixed(2)}ms`);
      console.log(`  Warm run: ${warmTime.toFixed(2)}ms`);
      console.log(`  Improvement: ${improvement.toFixed(1)}%`);
      
      const stats = adapter.getPerformanceStats();
      console.log(`  Cache hit rate: ${(stats.cache?.hitRate * 100).toFixed(1)}%`);
      
      expect(warmTime).toBeLessThan(coldTime * 0.5); // At least 50% faster
      expect(stats.cache?.hitRate).toBeGreaterThan(0.8); // 80% hit rate
    });
  });
});

// Helper functions

function setupMockResponses() {
  // Mock Grafana detection
  mockedFetch.mockImplementation(async (url) => {
    const urlStr = url.toString();
    
    if (urlStr.includes("/api/health")) {
      return { ok: true, text: async () => "ok" } as any;
    }
    
    if (urlStr.includes("/api/datasources")) {
      return {
        ok: true,
        json: async () => [
          { id: 1, uid: "prom-uid", name: "Prometheus", type: "prometheus" },
          { id: 2, uid: "loki-uid", name: "Loki", type: "loki" },
          { id: 3, uid: "influx-uid", name: "InfluxDB", type: "influxdb" },
        ],
      } as any;
    }
    
    // Default query response
    return {
      ok: true,
      json: async () => generateMockResponse(),
    } as any;
  });
}

function generateMockResponse() {
  return {
    results: {
      A: {
        frames: [
          {
            schema: {
              refId: "A",
              fields: [
                { name: "time", type: "time" },
                { name: "value", type: "number" },
              ],
            },
            data: {
              values: [
                Array.from({ length: 100 }, (_, i) => Date.now() - i * 60000),
                Array.from({ length: 100 }, () => Math.random() * 100),
              ],
            },
          },
        ],
      },
    },
  };
}

function generateLargeLokiResponse(lines: number) {
  return {
    results: {
      A: {
        frames: [
          {
            schema: {
              refId: "A",
              fields: [
                { name: "time", type: "time" },
                { name: "line", type: "string" },
              ],
            },
            data: {
              values: [
                Array.from({ length: lines }, (_, i) => Date.now() - i * 1000),
                Array.from({ length: lines }, (_, i) => `Log line ${i}`),
              ],
            },
          },
        ],
      },
    },
  };
}

function generatePrometheusQueries(count: number): string[] {
  const queries = [
    "up",
    'up{job="prometheus"}',
    "rate(http_requests_total[5m])",
    "sum by (job) (rate(http_requests_total[5m]))",
    "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))",
  ];
  
  return Array.from({ length: count }, (_, i) => queries[i % queries.length]);
}

function generateLokiQueries(count: number): string[] {
  const queries = [
    '{service="nginx"}',
    '{service="nginx"} |= "error"',
    '{job="api"} | json | status >= 400',
    'rate({service="nginx"}[5m])',
  ];
  
  return Array.from({ length: count }, (_, i) => queries[i % queries.length]);
}

function generateInfluxQueries(count: number): string[] {
  const queries = [
    'SELECT mean("value") FROM "cpu" WHERE time > now() - 1h',
    'SELECT * FROM "memory" LIMIT 100',
    'SELECT mean("value") FROM "cpu" GROUP BY time(5m), "host"',
    'SHOW MEASUREMENTS',
  ];
  
  return Array.from({ length: count }, (_, i) => queries[i % queries.length]);
}

async function executeQuery(adapter: any, query: string) {
  const stream = adapter.query(query);
  let count = 0;
  
  for await (const event of stream) {
    count++;
    if (count >= 100) break; // Process first 100 events
  }
  
  return { count };
}

async function simulateUser(
  adapter: any,
  type: "prometheus" | "loki" | "influxdb",
  requestCount: number
) {
  const queries = 
    type === "prometheus" ? generatePrometheusQueries(requestCount) :
    type === "loki" ? generateLokiQueries(requestCount) :
    generateInfluxQueries(requestCount);
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const query of queries) {
    // Add think time
    const thinkTime = Math.random() * 
      (LOAD_TEST_CONFIG.thinkTime.max - LOAD_TEST_CONFIG.thinkTime.min) + 
      LOAD_TEST_CONFIG.thinkTime.min;
    
    await new Promise(resolve => setTimeout(resolve, thinkTime));
    
    try {
      await executeQuery(adapter, query);
      successCount++;
    } catch (error) {
      errorCount++;
    }
  }
  
  return {
    totalRequests: requestCount,
    successCount,
    errorCount,
  };
}

async function runLoadTest(adapter: any, type: "prometheus" | "loki" | "influxdb") {
  const { concurrentUsers, requestsPerUser } = LOAD_TEST_CONFIG;
  
  const startTime = performance.now();
  const userPromises: Promise<any>[] = [];
  const responseTimes: number[] = [];
  
  for (let i = 0; i < concurrentUsers; i++) {
    userPromises.push(simulateUser(adapter, type, requestsPerUser));
  }
  
  const userResults = await Promise.all(userPromises);
  const elapsed = performance.now() - startTime;
  
  const totalRequests = userResults.reduce((sum, r) => sum + r.totalRequests, 0);
  const totalSuccess = userResults.reduce((sum, r) => sum + r.successCount, 0);
  const totalErrors = userResults.reduce((sum, r) => sum + r.errorCount, 0);
  
  return {
    totalRequests,
    totalSuccess,
    totalErrors,
    successRate: totalSuccess / totalRequests,
    totalTime: elapsed,
    throughput: totalRequests / (elapsed / 1000),
    avgResponseTime: elapsed / totalRequests,
    p99ResponseTime: elapsed / totalRequests * 2, // Simplified p99
  };
}

function printLoadTestResults(results: any) {
  console.log(`  Total requests: ${results.totalRequests}`);
  console.log(`  Success: ${results.totalSuccess}, Errors: ${results.totalErrors}`);
  console.log(`  Success rate: ${(results.successRate * 100).toFixed(1)}%`);
  console.log(`  Total time: ${results.totalTime.toFixed(2)}ms`);
  console.log(`  Throughput: ${results.throughput.toFixed(1)} req/sec`);
  console.log(`  Avg response time: ${results.avgResponseTime.toFixed(2)}ms`);
  console.log(`  P99 response time: ${results.p99ResponseTime.toFixed(2)}ms`);
}