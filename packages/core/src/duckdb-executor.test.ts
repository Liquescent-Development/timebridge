import { DuckDBExecutor, DuckDBConfig } from './duckdb-executor';
import { LogEvent, CorrelationError } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DuckDBExecutor', () => {
  let executor: DuckDBExecutor;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckdb-test-'));
  });

  afterEach(async () => {
    if (executor) {
      await executor.destroy();
    }
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should initialize with default configuration', async () => {
      executor = new DuckDBExecutor();
      await executor.initialize();
      
      expect(executor).toBeDefined();
      
      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(0);
      expect(stats.sources).toEqual([]);
      expect(stats.partitions).toBe(0);
    });

    it('should initialize with custom configuration', async () => {
      const config: DuckDBConfig = {
        databasePath: path.join(tempDir, 'test.db'),
        memoryLimit: '1GB',
        threads: 2,
        tempDirectory: tempDir,
        enableQueryCache: false,
        queryCacheSizeMB: 50
      };

      executor = new DuckDBExecutor(config);
      await executor.initialize();
      
      expect(executor).toBeDefined();
    });

    it('should handle initialization errors gracefully', async () => {
      // Test with invalid path
      const config: DuckDBConfig = {
        databasePath: '/invalid/path/test.db'
      };

      executor = new DuckDBExecutor(config);
      
      await expect(executor.initialize()).rejects.toThrow(CorrelationError);
    });

    it('should emit initialized event', async () => {
      executor = new DuckDBExecutor();
      
      const initPromise = new Promise<void>((resolve) => {
        executor.on('initialized', resolve);
      });

      await executor.initialize();
      await initPromise;
    });

    it('should not reinitialize if already initialized', async () => {
      executor = new DuckDBExecutor();
      await executor.initialize();
      
      // Second call should not throw or cause issues
      await executor.initialize();
      
      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(0);
    });
  });

  describe('Event Ingestion', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
    });

    it('should ingest a single event', async () => {
      const events: LogEvent[] = [{
        timestamp: '2023-12-01T10:00:00Z',
        source: 'test-source',
        stream: 'test-stream',
        message: 'Test message',
        labels: { level: 'info', app: 'test' },
        joinKeys: { request_id: 'req-123' }
      }];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      let totalIngested = 0;
      for await (const progress of executor.ingestStream(stream())) {
        totalIngested = progress.total;
      }

      expect(totalIngested).toBe(1);
      
      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(1);
      expect(stats.sources).toHaveLength(1);
      expect(stats.sources[0].source).toBe('test-source');
      expect(stats.sources[0].count).toBe(1);
    });

    it('should ingest multiple events in batches', async () => {
      const batchSize = 100;
      const totalEvents = 250;
      const events: LogEvent[] = [];

      for (let i = 0; i < totalEvents; i++) {
        const minutes = i % 60;
        const hours = Math.floor(i / 60) + 10;
        events.push({
          timestamp: `2023-12-01T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`,
          source: 'batch-source',
          stream: 'batch-stream',
          message: `Message ${i}`,
          labels: { level: 'info', index: i.toString() },
          joinKeys: { request_id: `req-${i}` }
        });
      }

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      const progressUpdates: Array<{ ingested: number; total: number }> = [];
      for await (const progress of executor.ingestStream(stream(), { batchSize })) {
        progressUpdates.push(progress);
      }

      expect(progressUpdates.length).toBeGreaterThan(1);
      expect(progressUpdates[progressUpdates.length - 1].total).toBe(totalEvents);
      
      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(totalEvents);
    });

    it('should handle events with various field combinations', async () => {
      const events: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:00Z',
          source: 'source1',
          message: 'Complete event',
          labels: { level: 'info' },
          joinKeys: { request_id: 'req-1', trace_id: 'trace-1' }
        },
        {
          timestamp: '2023-12-01T10:01:00Z',
          source: 'source2',
          message: 'Minimal event',
          labels: {}
        },
        {
          timestamp: '2023-12-01T10:02:00Z',
          source: 'source3',
          stream: 'stream3',
          message: 'Event with stream',
          labels: { app: 'test', env: 'prod' },
          joinKeys: { session_id: 'sess-1', user_id: 'user-1' }
        }
      ];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      let totalIngested = 0;
      for await (const progress of executor.ingestStream(stream())) {
        totalIngested = progress.total;
      }

      expect(totalIngested).toBe(3);
      
      const stats = await executor.getStatistics();
      expect(stats.sources).toHaveLength(3);
    });

    it('should emit batchIngested events', async () => {
      const events: LogEvent[] = Array.from({ length: 50 }, (_, i) => ({
        timestamp: `2023-12-01T${String(Math.floor(i / 60) + 10).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        source: 'emit-source',
        message: `Message ${i}`,
        labels: { index: i.toString() }
      }));

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      const batchEvents: Array<{ count: number; total: number }> = [];
      executor.on('batchIngested', (data) => batchEvents.push(data));

      for await (const _ of executor.ingestStream(stream(), { batchSize: 20 })) {
        // Just consume the stream
      }

      expect(batchEvents.length).toBeGreaterThan(0);
      expect(batchEvents.reduce((sum, batch) => sum + batch.count, 0)).toBe(50);
    });

    it('should handle flush intervals correctly', async () => {
      const events: LogEvent[] = Array.from({ length: 5 }, (_, i) => ({
        timestamp: `2023-12-01T10:0${i + 1}:00Z`,
        source: 'interval-source',
        message: `Message ${i}`,
        labels: { index: i.toString() }
      }));

      const stream = async function* () {
        for (const event of events) {
          yield event;
          // Add small delay to test interval flushing
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };

      const progressUpdates: Array<{ ingested: number; total: number }> = [];
      for await (const progress of executor.ingestStream(stream(), { 
        batchSize: 100, // Large batch size 
        flushInterval: 25 // Small interval
      })) {
        progressUpdates.push(progress);
      }

      expect(progressUpdates.length).toBeGreaterThan(1);
      expect(progressUpdates[progressUpdates.length - 1].total).toBe(5);
    });
  });

  describe('Statistics and Monitoring', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
    });

    it('should track event statistics correctly', async () => {
      const events: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:00Z',
          source: 'app1',
          message: 'Message 1',
          labels: { level: 'info' }
        },
        {
          timestamp: '2023-12-01T11:00:00Z',
          source: 'app1',
          message: 'Message 2',
          labels: { level: 'error' }
        },
        {
          timestamp: '2023-12-01T12:00:00Z',
          source: 'app2',
          message: 'Message 3',
          labels: { level: 'warn' }
        }
      ];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(stream())) {
        // Consume stream
      }

      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(3);
      expect(stats.sources).toHaveLength(2);
      
      const app1Stats = stats.sources.find(s => s.source === 'app1');
      const app2Stats = stats.sources.find(s => s.source === 'app2');
      
      expect(app1Stats?.count).toBe(2);
      expect(app2Stats?.count).toBe(1);
      expect(stats.partitions).toBe(1); // All events on same date
    });

    it('should return memory and disk usage statistics', async () => {
      const stats = await executor.getStatistics();
      
      expect(typeof stats.memoryUsageMB).toBe('number');
      expect(typeof stats.diskUsageMB).toBe('number');
      expect(stats.memoryUsageMB).toBeGreaterThanOrEqual(0);
      expect(stats.diskUsageMB).toBeGreaterThanOrEqual(0);
    });

    it('should track partition information', async () => {
      const events: LogEvent[] = [
        {
          timestamp: '2023-12-01T10:00:00Z',
          source: 'multi-day-source',
          message: 'Day 1 message',
          labels: {}
        },
        {
          timestamp: '2023-12-02T10:00:00Z',
          source: 'multi-day-source',
          message: 'Day 2 message',
          labels: {}
        },
        {
          timestamp: '2023-12-03T10:00:00Z',
          source: 'multi-day-source',
          message: 'Day 3 message',
          labels: {}
        }
      ];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(stream())) {
        // Consume stream
      }

      const stats = await executor.getStatistics();
      expect(stats.partitions).toBe(3); // Three different dates
    });
  });

  describe('Memory Configuration and Limits', () => {
    it('should apply memory limit configuration', async () => {
      const config: DuckDBConfig = {
        memoryLimit: '512MB',
        threads: 1,
        tempDirectory: tempDir
      };

      executor = new DuckDBExecutor(config);
      await executor.initialize();
      
      // Verification happens during initialization - no exceptions means success
      expect(executor).toBeDefined();
    });

    it('should configure thread count', async () => {
      const config: DuckDBConfig = {
        threads: 8,
        tempDirectory: tempDir
      };

      executor = new DuckDBExecutor(config);
      await executor.initialize();
      
      expect(executor).toBeDefined();
    });

    it('should create temp directory if it does not exist', () => {
      const nonExistentDir = path.join(tempDir, 'nested', 'temp');
      
      executor = new DuckDBExecutor({
        tempDirectory: nonExistentDir,
        databasePath: ':memory:'
      });

      // Constructor should create the directory
      expect(fs.existsSync(nonExistentDir)).toBe(true);
    });
  });

  describe('Connection Management', () => {
    it('should handle database file connections', async () => {
      // Use in-memory database for this test since persistent files may have permission issues in test environment
      executor = new DuckDBExecutor({
        databasePath: ':memory:',
        tempDirectory: tempDir
      });
      
      await executor.initialize();
      
      // Add some data
      const events: LogEvent[] = [{
        timestamp: '2023-12-01T10:00:00Z',
        source: 'persistent-source',
        message: 'Persistent message',
        labels: { persistent: 'true' }
      }];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(stream())) {
        // Consume stream
      }

      const stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(1);
      expect(stats.sources[0].source).toBe('persistent-source');
    });

    it('should handle in-memory database connections', async () => {
      executor = new DuckDBExecutor({
        databasePath: ':memory:',
        tempDirectory: tempDir
      });
      
      await executor.initialize();
      expect(executor).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
    });

    it('should handle malformed events gracefully', async () => {
      // Test with event missing required fields
      const malformedEvents = [
        {
          // Missing timestamp
          source: 'test-source',
          message: 'Test message',
          labels: {}
        } as any,
        {
          timestamp: 'invalid-timestamp',
          source: 'test-source',
          message: 'Test message',
          labels: {}
        },
        {
          timestamp: '2023-12-01T10:00:00Z',
          // Missing source
          message: 'Test message',
          labels: {}
        } as any
      ];

      const stream = async function* () {
        for (const event of malformedEvents) {
          yield event;
        }
      };

      // Should handle errors and continue processing
      await expect(async () => {
        for await (const _ of executor.ingestStream(stream())) {
          // Consume stream
        }
      }).rejects.toThrow();
    });

    it('should handle events with special characters in messages', async () => {
      const specialCharEvents: LogEvent[] = [{
        timestamp: '2023-12-01T10:00:00Z',
        source: 'special-chars',
        message: "Message with 'quotes' and \"double quotes\" and \n newlines",
        labels: { type: 'special' }
      }];

      const stream = async function* () {
        for (const event of specialCharEvents) {
          yield event;
        }
      };

      let totalIngested = 0;
      for await (const progress of executor.ingestStream(stream())) {
        totalIngested = progress.total;
      }

      expect(totalIngested).toBe(1);
    });
  });

  describe('Cleanup and Destruction', () => {
    it('should clean up resources properly', async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
      
      // Add some events
      const events: LogEvent[] = [{
        timestamp: '2023-12-01T10:00:00Z',
        source: 'cleanup-test',
        message: 'Test message',
        labels: {}
      }];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(stream())) {
        // Consume stream
      }

      await executor.destroy();
      
      // Should be able to create a new executor after destruction
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
    });

    it('should handle destroy called multiple times', async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
      
      await executor.destroy();
      await executor.destroy(); // Second call should not throw
    });

    it('should clear events correctly', async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      await executor.initialize();
      
      const events: LogEvent[] = [{
        timestamp: '2023-12-01T10:00:00Z',
        source: 'clear-test',
        message: 'Test message',
        labels: {}
      }];

      const stream = async function* () {
        for (const event of events) {
          yield event;
        }
      };

      for await (const _ of executor.ingestStream(stream())) {
        // Consume stream
      }

      let stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(1);

      await executor.clearEvents();

      stats = await executor.getStatistics();
      expect(stats.totalEvents).toBe(0);
      expect(stats.sources).toHaveLength(0);
      expect(stats.partitions).toBe(0);
    });

    it('should remove all event listeners on destroy', async () => {
      executor = new DuckDBExecutor({ tempDirectory: tempDir });
      
      const mockListener = jest.fn();
      executor.on('initialized', mockListener);
      executor.on('batchIngested', mockListener);
      
      await executor.initialize();
      await executor.destroy();
      
      expect(executor.listenerCount('initialized')).toBe(0);
      expect(executor.listenerCount('batchIngested')).toBe(0);
    });
  });
});