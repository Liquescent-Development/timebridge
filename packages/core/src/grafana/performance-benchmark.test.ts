/**
 * Performance Benchmark Tests for Grafana Integration
 * 
 * These tests measure the performance impact of various optimizations
 * and compare direct vs Grafana-proxied connections.
 */

import { GrafanaDataSourceProxy } from "./grafana-datasource-proxy";
import { ConnectionPool } from "./connection-pool";
import { CacheManager, DataSourceCache } from "./cache-manager";
import { QueryBatcher, StreamOptimizer } from "./query-batcher";
import { performance } from "perf_hooks";

// Mock implementation for testing
class MockGrafanaProxy extends GrafanaDataSourceProxy {
  getDataSourceType(): string {
    return "mock";
  }

  transformQuery(query: string, datasourceUid: string, timeRange: any): any {
    return {
      queries: [{ query, datasource: { uid: datasourceUid }, refId: "A" }],
      from: timeRange.from,
      to: timeRange.to,
    };
  }

  async *parseResponse(response: any): AsyncIterable<any> {
    // Generate mock events
    for (let i = 0; i < 1000; i++) {
      yield {
        timestamp: new Date().toISOString(),
        source: "mock",
        message: `Event ${i}`,
        labels: { index: i },
      };
    }
  }
}

describe("Performance Benchmarks", () => {
  describe("Connection Pool Performance", () => {
    let pool: ConnectionPool;

    beforeEach(() => {
      pool = new ConnectionPool({
        maxConnections: 100,
        maxConnectionsPerHost: 10,
      });
    });

    afterEach(() => {
      pool.destroy();
    });

    it("should handle high concurrency efficiently", async () => {
      const concurrency = 100;
      const iterations = 1000;
      const hosts = ["host1.com", "host2.com", "host3.com"];

      const startTime = performance.now();
      const promises: Promise<void>[] = [];

      for (let i = 0; i < iterations; i++) {
        const host = hosts[i % hosts.length];
        promises.push(
          pool.acquireConnection(host).then(() => {
            // Simulate work
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                pool.releaseConnection(host);
                resolve();
              }, Math.random() * 10);
            });
          })
        );
      }

      await Promise.all(promises);
      const elapsed = performance.now() - startTime;

      console.log(`Connection pool handled ${iterations} requests in ${elapsed.toFixed(2)}ms`);
      console.log(`Average: ${(elapsed / iterations).toFixed(3)}ms per request`);

      expect(elapsed).toBeLessThan(5000); // Should complete in under 5 seconds
    });

    it("should efficiently queue and process requests", async () => {
      const host = "test.com";
      const batchSize = 50;

      // Fill up the connection limit
      for (let i = 0; i < 10; i++) {
        await pool.acquireConnection(host);
      }

      const startTime = performance.now();
      const queuedPromises: Promise<void>[] = [];

      // Queue additional requests
      for (let i = 0; i < batchSize; i++) {
        queuedPromises.push(pool.acquireConnection(host));
      }

      // Release connections gradually
      for (let i = 0; i < 10; i++) {
        setTimeout(() => pool.releaseConnection(host), i * 10);
      }

      // Wait for initial release
      await new Promise(resolve => setTimeout(resolve, 150));

      // Release all remaining connections
      for (let i = 0; i < batchSize; i++) {
        pool.releaseConnection(host);
      }

      await Promise.all(queuedPromises);
      const elapsed = performance.now() - startTime;

      console.log(`Processed ${batchSize} queued requests in ${elapsed.toFixed(2)}ms`);

      const stats = pool.getStats();
      expect(stats.queuedRequests).toBe(0);
    }, 10000);
  });

  describe("Cache Performance", () => {
    let cache: CacheManager<any>;

    beforeEach(() => {
      cache = new CacheManager({
        maxSize: 10 * 1024 * 1024, // 10MB
        defaultTTL: 60000,
        maxEntries: 10000,
      });
    });

    afterEach(() => {
      cache.destroy();
    });

    it("should handle high-speed cache operations", () => {
      const operations = 10000;
      const data = { test: "data", value: Math.random() };

      // Write performance
      const writeStart = performance.now();
      for (let i = 0; i < operations; i++) {
        cache.set(`key${i}`, { ...data, index: i });
      }
      const writeElapsed = performance.now() - writeStart;

      // Read performance (all hits)
      const readStart = performance.now();
      for (let i = 0; i < operations; i++) {
        cache.get(`key${i}`);
      }
      const readElapsed = performance.now() - readStart;

      // Mixed operations
      const mixedStart = performance.now();
      for (let i = 0; i < operations; i++) {
        if (i % 3 === 0) {
          cache.set(`mixed${i}`, data);
        } else {
          cache.get(`key${i % operations}`);
        }
      }
      const mixedElapsed = performance.now() - mixedStart;

      console.log(`Cache Performance (${operations} operations):`);
      console.log(`  Writes: ${writeElapsed.toFixed(2)}ms (${(operations / writeElapsed * 1000).toFixed(0)} ops/sec)`);
      console.log(`  Reads: ${readElapsed.toFixed(2)}ms (${(operations / readElapsed * 1000).toFixed(0)} ops/sec)`);
      console.log(`  Mixed: ${mixedElapsed.toFixed(2)}ms (${(operations / mixedElapsed * 1000).toFixed(0)} ops/sec)`);

      const stats = cache.getStats();
      console.log(`  Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);

      expect(writeElapsed).toBeLessThan(1000);
      expect(readElapsed).toBeLessThan(500);
    });

    it("should efficiently handle LRU eviction", () => {
      const smallCache = new CacheManager({
        maxEntries: 100,
        maxSize: 1024 * 100, // 100KB
      });

      const startTime = performance.now();

      // Fill cache beyond capacity
      for (let i = 0; i < 1000; i++) {
        smallCache.set(`key${i}`, { data: `value${i}`.repeat(10) });
      }

      const elapsed = performance.now() - startTime;
      const stats = smallCache.getStats();

      console.log(`LRU eviction test:`);
      console.log(`  Added 1000 items in ${elapsed.toFixed(2)}ms`);
      console.log(`  Final entries: ${stats.entries}`);
      console.log(`  Evictions: ${stats.evictions}`);

      expect(stats.entries).toBeLessThanOrEqual(100);
      expect(stats.evictions).toBeGreaterThan(0);

      smallCache.destroy();
    });
  });

  describe("Query Batching Performance", () => {
    let batcher: QueryBatcher;

    beforeEach(() => {
      batcher = new QueryBatcher({
        maxBatchSize: 20,
        batchTimeout: 50,
        maxConcurrent: 5,
      });
    });

    afterEach(() => {
      batcher.destroy();
    });

    it("should efficiently batch queries", async () => {
      const queryCount = 100;
      const queries = Array.from({ length: queryCount }, (_, i) => ({
        queries: [{ refId: `Q${i}`, datasource: { uid: "test-uid" } }],
        from: "0",
        to: "100",
      }));

      const startTime = performance.now();
      const promises = queries.map(q => batcher.addQuery(q));

      // Wait for all batches to complete
      await Promise.all(promises);
      const elapsed = performance.now() - startTime;

      const stats = batcher.getStats();
      
      console.log(`Query batching performance:`);
      console.log(`  Processed ${queryCount} queries in ${elapsed.toFixed(2)}ms`);
      console.log(`  Total batches: ${stats.totalBatches}`);
      console.log(`  Average batch size: ${stats.averageBatchSize.toFixed(1)}`);
      console.log(`  Queries per second: ${(queryCount / elapsed * 1000).toFixed(0)}`);

      expect(stats.totalBatches).toBeLessThan(queryCount); // Should batch effectively
      expect(stats.averageBatchSize).toBeGreaterThan(1);
    });
  });

  describe("Stream Optimization Performance", () => {
    let optimizer: StreamOptimizer;

    beforeEach(() => {
      optimizer = new StreamOptimizer(1000, false);
    });

    it("should improve stream processing performance", async () => {
      const itemCount = 100000;
      
      // Create a large stream
      async function* largeStream() {
        for (let i = 0; i < itemCount; i++) {
          yield { index: i, data: `item${i}` };
        }
      }

      // Process without optimization
      const unoptimizedStart = performance.now();
      let unoptimizedCount = 0;
      for await (const item of largeStream()) {
        unoptimizedCount++;
      }
      const unoptimizedElapsed = performance.now() - unoptimizedStart;

      // Process with optimization
      const optimizedStart = performance.now();
      let optimizedCount = 0;
      for await (const item of optimizer.optimize(largeStream())) {
        optimizedCount++;
      }
      const optimizedElapsed = performance.now() - optimizedStart;

      console.log(`Stream optimization (${itemCount} items):`);
      console.log(`  Unoptimized: ${unoptimizedElapsed.toFixed(2)}ms`);
      console.log(`  Optimized: ${optimizedElapsed.toFixed(2)}ms`);
      console.log(`  Improvement: ${((1 - optimizedElapsed / unoptimizedElapsed) * 100).toFixed(1)}%`);

      expect(optimizedCount).toBe(unoptimizedCount);
    });

    it("should handle backpressure efficiently", async () => {
      const itemCount = 10000;
      
      async function* fastProducer() {
        for (let i = 0; i < itemCount; i++) {
          yield i;
        }
      }

      const startTime = performance.now();
      const stream = optimizer.withBackpressure(fastProducer(), 100, 0.8, 0.5);
      
      let count = 0;
      let maxMemory = 0;
      const memorySnapshots: number[] = [];

      for await (const item of stream) {
        count++;
        
        // Simulate slow consumer
        if (count % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1));
          
          // Track memory usage
          const usage = process.memoryUsage();
          memorySnapshots.push(usage.heapUsed);
          maxMemory = Math.max(maxMemory, usage.heapUsed);
        }
      }

      const elapsed = performance.now() - startTime;
      
      console.log(`Backpressure handling:`);
      console.log(`  Processed ${count} items in ${elapsed.toFixed(2)}ms`);
      console.log(`  Max memory: ${(maxMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Memory stable: ${memorySnapshots.length > 2 && 
        Math.abs(memorySnapshots[memorySnapshots.length - 1] - memorySnapshots[0]) < 10 * 1024 * 1024}`);

      expect(count).toBe(itemCount);
    });
  });

  describe("End-to-End Performance Comparison", () => {
    it("should demonstrate optimization benefits", async () => {
      // Create proxy without optimizations
      const unoptimizedProxy = new MockGrafanaProxy({
        grafanaUrl: "http://test.com",
        authToken: "token",
        optimization: {
          connectionPool: false,
          queryBatching: false,
          caching: false,
          compression: false,
          streamOptimization: false,
        },
      });

      // Create proxy with all optimizations
      const optimizedProxy = new MockGrafanaProxy({
        grafanaUrl: "http://test.com",
        authToken: "token",
        optimization: {
          connectionPool: true,
          queryBatching: true,
          caching: true,
          compression: true,
          streamOptimization: true,
        },
      });

      const queries = Array.from({ length: 10 }, (_, i) => `query${i}`);
      const timeRange = { from: new Date(), to: new Date() };

      // Test unoptimized
      const unoptimizedStart = performance.now();
      for (const query of queries) {
        const stream = await unoptimizedProxy.executeQuery(query, timeRange);
        let count = 0;
        for await (const event of stream) {
          count++;
          if (count >= 100) break; // Process first 100 events
        }
      }
      const unoptimizedElapsed = performance.now() - unoptimizedStart;

      // Test optimized (first run - cache miss)
      const optimizedStart1 = performance.now();
      for (const query of queries) {
        const stream = await optimizedProxy.executeQuery(query, timeRange);
        let count = 0;
        for await (const event of stream) {
          count++;
          if (count >= 100) break;
        }
      }
      const optimizedElapsed1 = performance.now() - optimizedStart1;

      // Test optimized (second run - cache hit)
      const optimizedStart2 = performance.now();
      for (const query of queries) {
        const stream = await optimizedProxy.executeQuery(query, timeRange);
        let count = 0;
        for await (const event of stream) {
          count++;
          if (count >= 100) break;
        }
      }
      const optimizedElapsed2 = performance.now() - optimizedStart2;

      console.log(`End-to-end performance comparison:`);
      console.log(`  Unoptimized: ${unoptimizedElapsed.toFixed(2)}ms`);
      console.log(`  Optimized (cold): ${optimizedElapsed1.toFixed(2)}ms`);
      console.log(`  Optimized (warm): ${optimizedElapsed2.toFixed(2)}ms`);
      console.log(`  Cold improvement: ${((1 - optimizedElapsed1 / unoptimizedElapsed) * 100).toFixed(1)}%`);
      console.log(`  Warm improvement: ${((1 - optimizedElapsed2 / unoptimizedElapsed) * 100).toFixed(1)}%`);

      const stats = optimizedProxy.getPerformanceStats();
      console.log(`  Cache hit rate: ${(stats.cache?.hitRate * 100).toFixed(1)}%`);

      // Cleanup
      unoptimizedProxy.destroy();
      optimizedProxy.destroy();

      expect(optimizedElapsed2).toBeLessThan(unoptimizedElapsed);
    }, 10000);
  });

  describe("Memory Usage Analysis", () => {
    it("should maintain reasonable memory usage", async () => {
      const proxy = new MockGrafanaProxy({
        grafanaUrl: "http://test.com",
        authToken: "token",
        optimization: {
          caching: { maxSize: 50 * 1024 * 1024, ttl: 60000 },
        },
      });

      const initialMemory = process.memoryUsage().heapUsed;
      const memorySnapshots: number[] = [];

      // Execute many queries
      for (let i = 0; i < 100; i++) {
        const stream = await proxy.executeQuery(
          `query${i}`,
          { from: new Date(), to: new Date() }
        );
        
        let count = 0;
        for await (const event of stream) {
          count++;
          if (count >= 100) break;
        }

        if (i % 10 === 0) {
          global.gc && global.gc(); // Force GC if available
          const currentMemory = process.memoryUsage().heapUsed;
          memorySnapshots.push(currentMemory);
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = (finalMemory - initialMemory) / 1024 / 1024;

      console.log(`Memory usage analysis:`);
      console.log(`  Initial: ${(initialMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Final: ${(finalMemory / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Increase: ${memoryIncrease.toFixed(2)}MB`);
      console.log(`  Peak: ${(Math.max(...memorySnapshots) / 1024 / 1024).toFixed(2)}MB`);

      proxy.destroy();

      expect(memoryIncrease).toBeLessThan(100); // Less than 100MB increase
    }, 10000);
  });
});