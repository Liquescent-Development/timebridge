import { DuckDBExecutor } from './duckdb-executor';
import { TimeQLToSQLGenerator } from './timeql-to-sql';
import { DiskSpillableStorage } from './disk-spillable-storage';
import { LogEvent, ParsedQuery, JoinType } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DuckDB Integration Tests', () => {
  let executor: DuckDBExecutor;
  let sqlGenerator: TimeQLToSQLGenerator;
  let spillableStorage: DiskSpillableStorage;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckdb-integration-test-'));
  });

  afterEach(async () => {
    if (executor) {
      await executor.destroy();
    }
    if (spillableStorage) {
      await spillableStorage.cleanup();
    }
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('End-to-End Correlation Pipeline', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({
        tempDirectory: tempDir,
        memoryLimit: '512MB'
      });
      sqlGenerator = new TimeQLToSQLGenerator();
      spillableStorage = new DiskSpillableStorage({
        maxMemoryMB: 10,
        spillDirectory: path.join(tempDir, 'spill')
      });

      await executor.initialize();
    });

    it('should perform complete request-response correlation', async () => {
      // Create test data: requests and responses
      const requests: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:00Z',
          source: 'frontend',
          stream: 'requests',
          message: 'GET /api/users',
          labels: { method: 'GET', path: '/api/users', level: 'info' },
          joinKeys: { request_id: 'req-001', trace_id: 'trace-001' }
        },
        {
          timestamp: '2023-12-01T10:00:05Z',
          source: 'frontend',
          stream: 'requests',
          message: 'POST /api/orders',
          labels: { method: 'POST', path: '/api/orders', level: 'info' },
          joinKeys: { request_id: 'req-002', trace_id: 'trace-002' }
        },
        {
          timestamp: '2023-12-01T10:00:10Z',
          source: 'frontend',
          stream: 'requests',
          message: 'GET /api/products',
          labels: { method: 'GET', path: '/api/products', level: 'info' },
          joinKeys: { request_id: 'req-003', trace_id: 'trace-003' }
        }
      ];

      const responses: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:02Z',
          source: 'backend',
          stream: 'responses',
          message: 'Response 200 for users',
          labels: { status: '200', response_time: '150ms', level: 'info' },
          joinKeys: { request_id: 'req-001', trace_id: 'trace-001' }
        },
        {
          timestamp: '2023-12-01T10:00:07Z',
          source: 'backend',
          stream: 'responses',
          message: 'Response 201 for orders',
          labels: { status: '201', response_time: '300ms', level: 'info' },
          joinKeys: { request_id: 'req-002', trace_id: 'trace-002' }
        }
        // Note: req-003 has no response (for testing anti-joins)
      ];

      // Ingest data into DuckDB
      const requestStream = async function* () {
        for (const event of requests) {
          yield event;
        }
      };

      const responseStream = async function* () {
        for (const event of responses) {
          yield event;
        }
      };

      let totalIngested = 0;
      for await (const progress of executor.ingestStream(requestStream())) {
        totalIngested += progress.ingested;
      }
      for await (const progress of executor.ingestStream(responseStream())) {
        totalIngested += progress.ingested;
      }

      expect(totalIngested).toBe(5);

      // Test INNER JOIN correlation (requests WITH responses)
      const innerJoinQuery: ParsedQuery = {
        leftStream: {
          source: 'frontend',
          selector: '{method!="DELETE"}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'backend',
          selector: '{status~="2.*"}',
          timeRange: '1h'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id'],
        temporal: '10s'
      };

      const innerJoinSQL = sqlGenerator.generateSQL(innerJoinQuery);
      expect(innerJoinSQL).toContain('INNER JOIN');
      expect(innerJoinSQL).toContain('l.request_id = r.request_id');

      // Test correlation results
      const correlations = [];
      for await (const correlation of executor.correlate(innerJoinSQL)) {
        correlations.push(correlation);
      }

      expect(correlations.length).toBe(2); // req-001 and req-002 have responses

      // Test ANTI JOIN (requests WITHOUT responses)
      const antiJoinQuery: ParsedQuery = {
        leftStream: {
          source: 'frontend',
          selector: '{}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'backend',
          selector: '{}',
          timeRange: '1h'
        },
        joinType: 'unless' as JoinType,
        joinKeys: ['request_id'],
        temporal: '30s'
      };

      const antiJoinSQL = sqlGenerator.generateSQL(antiJoinQuery);
      const antiCorrelations = [];
      for await (const correlation of executor.correlate(antiJoinSQL)) {
        antiCorrelations.push(correlation);
      }

      expect(antiCorrelations.length).toBe(1); // Only req-003 has no response
    });

    it('should handle large dataset with spilling integration', async () => {
      // Create a large dataset that will exceed memory limits
      const largeDataset: LogEvent[] = [];
      const batchSize = 1000;
      const totalBatches = 5;

      for (let batch = 0; batch < totalBatches; batch++) {
        for (let i = 0; i < batchSize; i++) {
          const eventId = batch * batchSize + i;
          largeDataset.push({
            timestamp: new Date(Date.now() + eventId * 1000).toISOString(),
            source: i % 2 === 0 ? 'service-a' : 'service-b',
            stream: 'events',
            message: `Event ${eventId}: ${'data'.repeat(100)}`, // ~400 bytes per message
            labels: { 
              batch: batch.toString(),
              index: i.toString(),
              category: eventId % 3 === 0 ? 'critical' : 'normal'
            },
            joinKeys: { session_id: `session-${Math.floor(eventId / 100)}` }
          });
        }
      }

      // Use spillable storage for large dataset processing
      const storageKeys = new Set<string>();
      for (const event of largeDataset) {
        const key = `${event.source}-${event.labels.batch}`;
        await spillableStorage.add(key, event);
        storageKeys.add(key);
      }

      // Verify spillable storage handled the load
      const spillStats = spillableStorage.getStats();
      expect(spillStats.memoryKeys + spillStats.diskKeys).toBeGreaterThan(0);

      // Ingest into DuckDB in batches
      const largeStream = async function* () {
        for (const event of largeDataset) {
          yield event;
        }
      };

      let totalIngested = 0;
      for await (const progress of executor.ingestStream(largeStream(), { batchSize: 500 })) {
        totalIngested = progress.total;
      }

      expect(totalIngested).toBe(largeDataset.length);

      // Perform correlation on large dataset
      const largeDataQuery: ParsedQuery = {
        leftStream: {
          source: 'service-a',
          selector: '{category="critical"}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'service-b',
          selector: '{category!="debug"}',
          timeRange: '1h'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['session_id'],
        temporal: '5m'
      };

      const largeDataSQL = sqlGenerator.generateSQL(largeDataQuery);
      const correlations = [];
      for await (const correlation of executor.correlate(largeDataSQL)) {
        correlations.push(correlation);
      }

      expect(correlations.length).toBeGreaterThan(0);

      // Verify statistics
      const dbStats = await executor.getStatistics();
      expect(dbStats.totalEvents).toBe(largeDataset.length);
      expect(dbStats.sources.length).toBe(2);
    });

    it('should support multi-stream correlation scenarios', async () => {
      // Create three-way correlation: frontend -> backend -> database
      const frontendEvents: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:00Z',
          source: 'frontend',
          message: 'User login request',
          labels: { action: 'login', user: 'alice' },
          joinKeys: { trace_id: 'trace-login-1', session_id: 'sess-1' }
        },
        {
          timestamp: '2023-12-01T10:01:00Z',
          source: 'frontend',
          message: 'Data fetch request',
          labels: { action: 'fetch', user: 'bob' },
          joinKeys: { trace_id: 'trace-fetch-1', session_id: 'sess-2' }
        }
      ];

      const backendEvents: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:01Z',
          source: 'backend',
          message: 'Processing login',
          labels: { operation: 'authenticate', duration: '50ms' },
          joinKeys: { trace_id: 'trace-login-1', query_id: 'q-1' }
        },
        {
          timestamp: '2023-12-01T10:01:01Z',
          source: 'backend',
          message: 'Processing data fetch',
          labels: { operation: 'query', duration: '200ms' },
          joinKeys: { trace_id: 'trace-fetch-1', query_id: 'q-2' }
        }
      ];

      const databaseEvents: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:02Z',
          source: 'database',
          message: 'User authentication query',
          labels: { table: 'users', type: 'SELECT' },
          joinKeys: { query_id: 'q-1' }
        },
        {
          timestamp: '2023-12-01T10:01:02Z',
          source: 'database',
          message: 'Data retrieval query',
          labels: { table: 'products', type: 'SELECT' },
          joinKeys: { query_id: 'q-2' }
        }
      ];

      // Ingest all three streams
      const allEvents = [...frontendEvents, ...backendEvents, ...databaseEvents];
      const multiStream = async function* () {
        for (const event of allEvents) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(multiStream())) {
        // Consume stream
      }

      // Test three-way correlation query
      const multiStreamQuery: ParsedQuery = {
        leftStream: {
          source: 'frontend',
          selector: '{action!="logout"}',
          timeRange: '2m'
        },
        rightStream: {
          source: 'backend',
          selector: '{operation!="cache"}',
          timeRange: '2m'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['trace_id'],
        temporal: '5s',
        additionalStreams: [
          {
            source: 'database',
            selector: '{type="SELECT"}'
          }
        ]
      };

      const multiStreamSQL = sqlGenerator.generateMultiStreamSQL(multiStreamQuery);
      expect(multiStreamSQL).toContain('stream_3 AS');

      // Test statistics generation
      const statsSQL = sqlGenerator.generateStatsSQL(multiStreamQuery);
      const statsResults = await executor.execute(statsSQL);
      expect(Array.isArray(statsResults)).toBe(true);
    });

    it('should handle complex temporal window correlations', async () => {
      // Create events with precise timing for temporal testing
      const events: LogEvent[] = [];
      const baseTime = new Date('2023-12-01T10:00:00Z').getTime();

      // Create events every 30 seconds for 5 minutes
      for (let i = 0; i < 10; i++) {
        const timestamp = new Date(baseTime + i * 30 * 1000).toISOString();
        
        // Service A events (every event)
        events.push({
          timestamp,
          source: 'service-a',
          message: `ServiceA event ${i}`,
          labels: { sequence: i.toString(), type: 'metric' },
          joinKeys: { correlation_id: `corr-${Math.floor(i / 2)}` }
        });

        // Service B events (every other event, offset by 10 seconds)
        if (i % 2 === 0) {
          events.push({
            timestamp: new Date(baseTime + i * 30 * 1000 + 10 * 1000).toISOString(),
            source: 'service-b',
            message: `ServiceB event ${i}`,
            labels: { sequence: i.toString(), type: 'response' },
            joinKeys: { correlation_id: `corr-${Math.floor(i / 2)}` }
          });
        }
      }

      const eventStream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(eventStream())) {
        // Consume stream
      }

      // Test different temporal windows
      const temporalQueries = [
        { window: '5s', expectedMatches: 0 }, // Too tight
        { window: '15s', expectedMatches: 5 }, // Just right
        { window: '60s', expectedMatches: 5 }, // Loose but should work
      ];

      for (const { window, expectedMatches } of temporalQueries) {
        const temporalQuery: ParsedQuery = {
          leftStream: {
            source: 'service-a',
            selector: '{type="metric"}',
            timeRange: '10m'
          },
          rightStream: {
            source: 'service-b',
            selector: '{type="response"}',
            timeRange: '10m'
          },
          joinType: 'and' as JoinType,
          joinKeys: ['correlation_id'],
          temporal: window
        };

        const temporalSQL = sqlGenerator.generateSQL(temporalQuery);
        const correlations = [];
        for await (const correlation of executor.correlate(temporalSQL)) {
          correlations.push(correlation);
        }

        expect(correlations.length).toBe(expectedMatches);
      }
    });
  });

  describe('Performance and Scalability Tests', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({
        tempDirectory: tempDir,
        memoryLimit: '1GB',
        threads: 4
      });
      sqlGenerator = new TimeQLToSQLGenerator({
        useApproximate: true,
        samplePercent: 10
      });

      await executor.initialize();
    });

    it('should handle high-throughput ingestion with correlation', async () => {
      const startTime = Date.now();
      const eventCount = 10000;
      const batchSize = 1000;

      // Generate high-volume test data
      const generateEvents = async function* () {
        for (let i = 0; i < eventCount; i++) {
          yield {
            timestamp: new Date(startTime + i * 100).toISOString(),
            source: i % 2 === 0 ? 'high-volume-a' : 'high-volume-b',
            message: `High volume event ${i}`,
            labels: { 
              batch: Math.floor(i / batchSize).toString(),
              priority: i % 10 === 0 ? 'high' : 'normal'
            },
            joinKeys: { 
              batch_id: `batch-${Math.floor(i / batchSize)}`,
              thread_id: `thread-${i % 4}`
            }
          };
        }
      };

      // Measure ingestion performance
      const ingestionStart = Date.now();
      let totalIngested = 0;
      for await (const progress of executor.ingestStream(generateEvents(), { batchSize })) {
        totalIngested = progress.total;
      }
      const ingestionTime = Date.now() - ingestionStart;

      expect(totalIngested).toBe(eventCount);
      console.log(`Ingested ${eventCount} events in ${ingestionTime}ms (${Math.round(eventCount / ingestionTime * 1000)} events/sec)`);

      // Measure correlation performance
      const correlationQuery: ParsedQuery = {
        leftStream: {
          source: 'high-volume-a',
          selector: '{priority="high"}',
          timeRange: '30m'
        },
        rightStream: {
          source: 'high-volume-b',
          selector: '{priority!="low"}',
          timeRange: '30m'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['batch_id'],
        temporal: '1m'
      };

      const correlationSQL = sqlGenerator.generateSQL(correlationQuery);
      const correlationStart = Date.now();
      
      const correlations = [];
      for await (const correlation of executor.correlate(correlationSQL)) {
        correlations.push(correlation);
      }
      
      const correlationTime = Date.now() - correlationStart;
      console.log(`Found ${correlations.length} correlations in ${correlationTime}ms`);

      // Verify statistics
      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(eventCount);
      expect(stats.sources.length).toBe(2);
    });

    it('should demonstrate approximate query benefits', async () => {
      const largeDataset = 5000;
      const events = Array.from({ length: largeDataset }, (_, i) => ({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        source: `source-${i % 10}`,
        message: `Approximation test event ${i}`,
        labels: { category: `cat-${i % 5}`, priority: i % 100 === 0 ? 'high' : 'normal' },
        joinKeys: { group_id: `group-${Math.floor(i / 100)}` }
      }));

      const dataStream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(dataStream())) {
        // Consume stream
      }

      // Test exact vs approximate queries
      const exactGenerator = new TimeQLToSQLGenerator({ useApproximate: false });
      const approxGenerator = new TimeQLToSQLGenerator({ 
        useApproximate: true, 
        samplePercent: 10 
      });

      const testQuery: ParsedQuery = {
        leftStream: {
          source: 'source-0',
          selector: '{}',
          timeRange: '2h'
        },
        rightStream: {
          source: 'source-1',
          selector: '{}',
          timeRange: '2h'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['group_id']
      };

      // Measure exact query
      const exactSQL = exactGenerator.generateSQL(testQuery);
      const exactStart = Date.now();
      const exactResults = [];
      for await (const result of executor.correlate(exactSQL)) {
        exactResults.push(result);
      }
      const exactTime = Date.now() - exactStart;

      // Measure approximate query
      const approxSQL = approxGenerator.generateSQL(testQuery);
      const approxStart = Date.now();
      const approxResults = [];
      for await (const result of executor.correlate(approxSQL)) {
        approxResults.push(result);
      }
      const approxTime = Date.now() - approxStart;

      console.log(`Exact: ${exactResults.length} results in ${exactTime}ms`);
      console.log(`Approximate: ${approxResults.length} results in ${approxTime}ms`);

      // Approximate should be faster (or at least not significantly slower for this dataset size)
      expect(approxTime).toBeLessThanOrEqual(exactTime * 2);
    });
  });

  describe('Error Handling and Recovery', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({
        tempDirectory: tempDir,
        memoryLimit: '256MB'
      });
      sqlGenerator = new TimeQLToSQLGenerator();
      spillableStorage = new DiskSpillableStorage({
        maxMemoryMB: 5,
        spillDirectory: path.join(tempDir, 'error-spill')
      });

      await executor.initialize();
    });

    it('should handle malformed SQL gracefully', async () => {
      const malformedQuery: ParsedQuery = {
        leftStream: {
          source: 'test-source',
          selector: '{invalid="selector}'  // Malformed selector
        },
        rightStream: {
          source: 'test-source-2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['invalid_key']
      };

      const malformedSQL = sqlGenerator.generateSQL(malformedQuery);
      
      // Should handle SQL errors gracefully
      await expect(async () => {
        const results = [];
        for await (const result of executor.correlate(malformedSQL)) {
          results.push(result);
        }
      }).rejects.toThrow();
    });

    it('should handle storage failures gracefully', async () => {
      // Create events that will trigger spilling
      const largeEvents = Array.from({ length: 100 }, (_, i) => ({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        source: 'failure-test',
        message: 'x'.repeat(1000),
        labels: { index: i.toString() }
      }));

      // Add events normally first
      for (let i = 0; i < 50; i++) {
        await spillableStorage.add(`normal-${i}`, largeEvents[i]);
      }

      // Simulate disk space issues by making spill directory read-only
      const spillDir = path.join(tempDir, 'error-spill');
      if (fs.existsSync(spillDir)) {
        fs.chmodSync(spillDir, 0o444);
      }

      // Adding more events should handle spill failures
      let errorThrown = false;
      try {
        for (let i = 50; i < 100; i++) {
          await spillableStorage.add(`error-prone-${i}`, largeEvents[i]);
        }
      } catch (error) {
        errorThrown = true;
      }

      // Restore permissions for cleanup
      if (fs.existsSync(spillDir)) {
        fs.chmodSync(spillDir, 0o755);
      }

      // Should have thrown an error due to spill failure
      expect(errorThrown).toBe(true);
    });

    it('should recover from database connection issues', async () => {
      const testEvents: LogEvent[] = [{
        timestamp: '2023-12-01T10:00:00Z',
        source: 'recovery-test',
        message: 'Test message',
        labels: {}
      }];

      const eventStream = async function* () {
        for (const event of testEvents) {
          yield event;
        }
      };

      // Normal operation
      for await (const _ of executor.ingestStream(eventStream())) {
        // Consume stream
      }

      // Destroy and recreate executor to simulate connection recovery
      await executor.destroy();
      
      executor = new DuckDBExecutor({
        tempDirectory: tempDir,
        memoryLimit: '256MB'
      });
      
      await executor.initialize();

      // Should be able to ingest after recovery
      for await (const _ of executor.ingestStream(eventStream())) {
        // Consume stream
      }

      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(1);
    });

    it('should handle concurrent access patterns', async () => {
      const concurrentEvents: LogEvent[] = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: new Date(Date.now() + i * 100).toISOString(),
        source: `concurrent-source-${i % 5}`,
        message: `Concurrent event ${i}`,
        labels: { thread: `thread-${i % 10}` },
        joinKeys: { batch: `batch-${Math.floor(i / 100)}` }
      }));

      // Simulate concurrent ingestion
      const streams = Array.from({ length: 5 }, (_, streamId) => {
        const streamEvents = concurrentEvents.filter((_, i) => i % 5 === streamId);
        return async function* () {
          for (const event of streamEvents) {
            yield event;
          }
        };
      });

      // Ingest all streams concurrently
      const ingestionPromises = streams.map(async (stream) => {
        for await (const _ of executor.ingestStream(stream())) {
          // Consume stream
        }
      });

      await Promise.all(ingestionPromises);

      // Verify all events were ingested correctly
      const finalStats = await executor.getStatistics();
      expect(finalStats.totalEvents).toBe(concurrentEvents.length);

      // Perform correlation on the concurrently ingested data
      const concurrentQuery: ParsedQuery = {
        leftStream: {
          source: 'concurrent-source-0',
          selector: '{}',
          timeRange: '5m'
        },
        rightStream: {
          source: 'concurrent-source-1',
          selector: '{}',
          timeRange: '5m'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['batch']
      };

      const concurrentSQL = sqlGenerator.generateSQL(concurrentQuery);
      const correlations = [];
      for await (const correlation of executor.correlate(concurrentSQL)) {
        correlations.push(correlation);
      }

      expect(correlations.length).toBeGreaterThan(0);
    });
  });

  describe('Query Optimization and Explain Plans', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({
        tempDirectory: tempDir,
        memoryLimit: '512MB',
        threads: 2
      });
      sqlGenerator = new TimeQLToSQLGenerator();

      await executor.initialize();
    });

    it('should generate and execute EXPLAIN queries for optimization', async () => {
      // Add some test data
      const testEvents: LogEvent[] = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        source: i % 3 === 0 ? 'app' : 'db',
        message: `Optimization test event ${i}`,
        labels: { category: i % 2 === 0 ? 'read' : 'write' },
        joinKeys: { transaction_id: `tx-${Math.floor(i / 10)}` }
      }));

      const optimizationStream = async function* () {
        for (const event of testEvents) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(optimizationStream())) {
        // Consume stream
      }

      const optimizationQuery: ParsedQuery = {
        leftStream: {
          source: 'app',
          selector: '{category="read"}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'db',
          selector: '{category="write"}',
          timeRange: '1h'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['transaction_id']
      };

      // Generate and execute EXPLAIN query
      const explainSQL = sqlGenerator.generateExplainSQL(optimizationQuery);
      expect(explainSQL.startsWith('EXPLAIN ANALYZE')).toBe(true);

      // Execute explain - should not throw
      const explainResults = await executor.execute(explainSQL);
      expect(Array.isArray(explainResults)).toBe(true);

      // Generate and execute statistics query
      const statsSQL = sqlGenerator.generateStatsSQL(optimizationQuery);
      const statsResults = await executor.execute(statsSQL);
      expect(Array.isArray(statsResults)).toBe(true);
      
      if (statsResults.length > 0) {
        expect(statsResults[0]).toHaveProperty('unique_keys');
        expect(statsResults[0]).toHaveProperty('total_events');
      }
    });
  });
});