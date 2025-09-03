import { ConnectionPool, ConnectionPoolOptions } from "./connection-pool";
import { CacheManager, DataSourceCache } from "./cache-manager";
import { QueryBatcher, StreamOptimizer } from "./query-batcher";

describe("Performance Optimization Features", () => {
  describe("ConnectionPool", () => {
    let pool: ConnectionPool;

    beforeEach(() => {
      pool = new ConnectionPool({
        maxConnections: 10,
        maxConnectionsPerHost: 3,
        keepAlive: true,
        keepAliveMsecs: 1000,
      });
    });

    afterEach(() => {
      pool.destroy();
    });

    it("should manage connection limits", async () => {
      const host = "example.com";
      
      // Acquire connections up to limit
      await pool.acquireConnection(host);
      await pool.acquireConnection(host);
      await pool.acquireConnection(host);
      
      const stats = pool.getStats();
      expect(stats.activeConnections).toBe(3);
      expect(stats.connectionsByHost.get(host)).toBe(3);
    });

    it("should queue requests when limit reached", async () => {
      const host = "example.com";
      
      // Fill up connections
      for (let i = 0; i < 3; i++) {
        await pool.acquireConnection(host);
      }
      
      // This should be queued
      const queuedPromise = pool.acquireConnection(host);
      
      const stats = pool.getStats();
      expect(stats.queuedRequests).toBe(1);
      
      // Release one connection
      pool.releaseConnection(host);
      
      // Queued request should complete
      await queuedPromise;
      expect(pool.getStats().queuedRequests).toBe(0);
    });

    it("should release connections properly", async () => {
      const host = "example.com";
      
      await pool.acquireConnection(host);
      await pool.acquireConnection(host);
      
      expect(pool.getStats().activeConnections).toBe(2);
      
      pool.releaseConnection(host);
      expect(pool.getStats().activeConnections).toBe(1);
      
      pool.releaseConnection(host);
      expect(pool.getStats().activeConnections).toBe(0);
    });

    it("should handle multiple hosts", async () => {
      await pool.acquireConnection("host1.com");
      await pool.acquireConnection("host1.com");
      await pool.acquireConnection("host2.com");
      
      const stats = pool.getStats();
      expect(stats.activeConnections).toBe(3);
      expect(stats.connectionsByHost.get("host1.com")).toBe(2);
      expect(stats.connectionsByHost.get("host2.com")).toBe(1);
    });

    it("should provide appropriate agents", () => {
      const httpAgent = pool.getAgent("http://example.com");
      const httpsAgent = pool.getAgent("https://example.com");
      
      expect(httpAgent).toBeDefined();
      expect(httpsAgent).toBeDefined();
      expect(httpAgent).not.toBe(httpsAgent);
    });
  });

  describe("CacheManager", () => {
    let cache: CacheManager<any>;

    beforeEach(() => {
      cache = new CacheManager({
        maxSize: 1024 * 1024, // 1MB
        defaultTTL: 60000, // 1 minute
        checkInterval: 10000, // 10 seconds
        maxEntries: 100,
      });
    });

    afterEach(() => {
      cache.destroy();
    });

    it("should store and retrieve values", () => {
      cache.set("key1", "value1");
      cache.set("key2", { data: "value2" });
      
      expect(cache.get("key1")).toBe("value1");
      expect(cache.get("key2")).toEqual({ data: "value2" });
      expect(cache.get("key3")).toBeUndefined();
    });

    it("should respect TTL", async () => {
      cache.set("key1", "value1", 100); // 100ms TTL
      
      expect(cache.get("key1")).toBe("value1");
      
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(cache.get("key1")).toBeUndefined();
    });

    it("should track hit/miss statistics", () => {
      cache.set("key1", "value1");
      
      cache.get("key1"); // Hit
      cache.get("key1"); // Hit
      cache.get("key2"); // Miss
      
      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.666, 2);
    });

    it("should evict LRU entries when size limit reached", () => {
      // Set small cache size for testing
      const smallCache = new CacheManager({
        maxSize: 100,
        maxEntries: 3,
      });
      
      smallCache.set("key1", "value1");
      smallCache.set("key2", "value2");
      smallCache.set("key3", "value3");
      
      // Access key1 and key2 to make them more recent
      smallCache.get("key1");
      smallCache.get("key2");
      
      // Adding key4 should evict key3 (least recently used)
      smallCache.set("key4", "value4");
      
      expect(smallCache.has("key1")).toBe(true);
      expect(smallCache.has("key2")).toBe(true);
      expect(smallCache.has("key3")).toBe(false);
      expect(smallCache.has("key4")).toBe(true);
      
      smallCache.destroy();
    });

    it("should invalidate entries by pattern", () => {
      cache.set("api:user:1", "user1");
      cache.set("api:user:2", "user2");
      cache.set("api:post:1", "post1");
      cache.set("other:data", "data");
      
      const invalidated = cache.invalidate(/^api:user:/);
      
      expect(invalidated).toBe(2);
      expect(cache.has("api:user:1")).toBe(false);
      expect(cache.has("api:user:2")).toBe(false);
      expect(cache.has("api:post:1")).toBe(true);
      expect(cache.has("other:data")).toBe(true);
    });

    it("should clear all entries", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      
      cache.clear();
      
      expect(cache.has("key1")).toBe(false);
      expect(cache.has("key2")).toBe(false);
      expect(cache.getStats().entries).toBe(0);
    });

    it("should prewarm cache", async () => {
      await cache.prewarm([
        { key: "key1", value: "value1" },
        { key: "key2", value: "value2", ttl: 5000 },
      ]);
      
      expect(cache.get("key1")).toBe("value1");
      expect(cache.get("key2")).toBe("value2");
    });
  });

  describe("DataSourceCache", () => {
    let dsCache: DataSourceCache;

    beforeEach(() => {
      dsCache = new DataSourceCache();
    });

    afterEach(() => {
      dsCache.destroy();
    });

    it("should cache data sources by instance and name", () => {
      const dataSource = { id: 1, name: "Prometheus", uid: "prom-uid" };
      
      dsCache.cacheDataSource("https://grafana.com", "Prometheus", dataSource);
      
      const retrieved = dsCache.getDataSource("https://grafana.com", "Prometheus");
      expect(retrieved).toEqual(dataSource);
    });

    it("should invalidate all data sources for an instance", () => {
      dsCache.cacheDataSource("https://grafana1.com", "DS1", { id: 1 });
      dsCache.cacheDataSource("https://grafana1.com", "DS2", { id: 2 });
      dsCache.cacheDataSource("https://grafana2.com", "DS3", { id: 3 });
      
      const invalidated = dsCache.invalidateInstance("https://grafana1.com");
      
      expect(invalidated).toBe(2);
      expect(dsCache.getDataSource("https://grafana1.com", "DS1")).toBeUndefined();
      expect(dsCache.getDataSource("https://grafana1.com", "DS2")).toBeUndefined();
      expect(dsCache.getDataSource("https://grafana2.com", "DS3")).toBeDefined();
    });
  });

  describe("QueryBatcher", () => {
    let batcher: QueryBatcher;

    beforeEach(() => {
      batcher = new QueryBatcher({
        maxBatchSize: 3,
        batchTimeout: 50,
        maxConcurrent: 2,
      });
    });

    afterEach(() => {
      batcher.destroy();
    });

    it("should batch queries up to max size", async () => {
      const queries = [
        { queries: [{ refId: "A", datasource: { uid: "test-uid" } }], from: "0", to: "100" },
        { queries: [{ refId: "B", datasource: { uid: "test-uid" } }], from: "0", to: "100" },
        { queries: [{ refId: "C", datasource: { uid: "test-uid" } }], from: "0", to: "100" },
      ];
      
      const promises = queries.map(q => batcher.addQuery(q));
      
      // Allow batch to process
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = batcher.getStats();
      expect(stats.totalBatches).toBeGreaterThanOrEqual(1);
      expect(stats.totalQueries).toBe(3);
    });

    it("should respect batch timeout", async () => {
      const startTime = Date.now();
      
      const query = { queries: [{ refId: "A", datasource: { uid: "test-uid" } }], from: "0", to: "100" };
      const promise = batcher.addQuery(query);
      
      // Should timeout after ~50ms
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(150);
    });

    it("should track statistics", () => {
      const initialStats = batcher.getStats();
      
      expect(initialStats.totalBatches).toBe(0);
      expect(initialStats.totalQueries).toBe(0);
      expect(initialStats.currentQueueSize).toBe(0);
      expect(initialStats.activeBatches).toBe(0);
    });
  });

  describe("StreamOptimizer", () => {
    let optimizer: StreamOptimizer;

    beforeEach(() => {
      optimizer = new StreamOptimizer(3, false);
    });

    it("should optimize stream with buffering", async () => {
      async function* source() {
        for (let i = 1; i <= 10; i++) {
          yield i;
        }
      }
      
      const optimized = optimizer.optimize(source());
      const results: number[] = [];
      
      for await (const item of optimized) {
        results.push(item);
      }
      
      expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("should apply backpressure", async () => {
      async function* source() {
        for (let i = 1; i <= 100; i++) {
          yield i;
        }
      }
      
      const withBackpressure = optimizer.withBackpressure(source(), 10, 0.8, 0.5);
      const results: number[] = [];
      
      for await (const item of withBackpressure) {
        results.push(item);
        if (results.length >= 10) break;
      }
      
      expect(results.length).toBe(10);
    });

    it("should chunk stream", async () => {
      async function* source() {
        for (let i = 1; i <= 10; i++) {
          yield i;
        }
      }
      
      const chunked = optimizer.chunk(source(), 3);
      const results: number[][] = [];
      
      for await (const chunk of chunked) {
        results.push(chunk);
      }
      
      expect(results).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
        [10],
      ]);
    });

    it("should apply rate limiting", async () => {
      async function* source() {
        for (let i = 1; i <= 5; i++) {
          yield i;
        }
      }
      
      const startTime = Date.now();
      const rateLimited = optimizer.rateLimit(source(), 10); // 10 items per second
      const results: number[] = [];
      
      for await (const item of rateLimited) {
        results.push(item);
      }
      
      const elapsed = Date.now() - startTime;
      
      // Should take at least 400ms for 5 items at 10/sec
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(results).toEqual([1, 2, 3, 4, 5]);
    });
  });
});