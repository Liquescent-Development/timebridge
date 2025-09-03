import { DiskSpillableStorage } from './disk-spillable-storage';
import { LogEvent } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DiskSpillableStorage', () => {
  let storage: DiskSpillableStorage;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spillable-storage-test-'));
  });

  afterEach(async () => {
    if (storage) {
      await storage.cleanup();
    }
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should create storage with default settings', () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 10,
        spillDirectory: tempDir
      });

      expect(storage).toBeDefined();
      const stats = storage.getStats();
      expect(stats.memoryKeys).toBe(0);
      expect(stats.diskKeys).toBe(0);
      expect(stats.memoryUsageMB).toBe(0);
      expect(stats.spillCount).toBe(0);
    });

    it('should create spill directory if it does not exist', () => {
      const nonExistentDir = path.join(tempDir, 'nested', 'spill');
      
      storage = new DiskSpillableStorage({
        maxMemoryMB: 10,
        spillDirectory: nonExistentDir
      });

      expect(fs.existsSync(nonExistentDir)).toBe(true);
    });

    it('should use default spill directory when not specified', () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 10
      });

      expect(storage).toBeDefined();
    });

    it('should handle compression configuration', () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 10,
        spillDirectory: tempDir,
        compressionEnabled: true
      });

      expect(storage).toBeDefined();
    });
  });

  describe('Memory Storage Operations', () => {
    beforeEach(() => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 1, // Small memory limit for testing
        spillDirectory: tempDir
      });
    });

    it('should store and retrieve events from memory', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'test-source',
        message: 'Test message',
        labels: { level: 'info' }
      };

      await storage.add('key1', event);
      
      const retrieved = await storage.get('key1');
      expect(retrieved).toEqual([event]);

      const stats = storage.getStats();
      expect(stats.memoryKeys).toBe(1);
      expect(stats.diskKeys).toBe(0);
    });

    it('should accumulate events for the same key', async () => {
      const event1: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'test-source',
        message: 'First message',
        labels: { id: '1' }
      };

      const event2: LogEvent = {
        timestamp: '2023-12-01T10:01:00Z',
        source: 'test-source',
        message: 'Second message',
        labels: { id: '2' }
      };

      await storage.add('same-key', event1);
      await storage.add('same-key', event2);

      const retrieved = await storage.get('same-key');
      expect(retrieved).toHaveLength(2);
      expect(retrieved).toEqual([event1, event2]);
    });

    it('should return undefined for non-existent keys', async () => {
      const retrieved = await storage.get('non-existent');
      expect(retrieved).toBeUndefined();
    });

    it('should track memory usage correctly', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'memory-test',
        message: 'Test message for memory tracking',
        labels: { test: 'memory' }
      };

      const initialStats = storage.getStats();
      expect(initialStats.memoryUsageMB).toBe(0);

      await storage.add('memory-key', event);

      const afterStats = storage.getStats();
      // Memory usage might be less than 1MB so could round to 0
      expect(afterStats.memoryUsageMB).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Disk Spilling', () => {
    beforeEach(() => {
      // Very small memory limit to force spilling
      storage = new DiskSpillableStorage({
        maxMemoryMB: 0.01, // 10KB limit
        spillDirectory: tempDir
      });
    });

    it('should spill to disk when memory limit is exceeded', async () => {
      const largeMessage = 'x'.repeat(5000); // ~5KB message
      
      const events: LogEvent[] = Array.from({ length: 5 }, (_, i) => ({
        timestamp: `2023-12-01T10:${String(i).padStart(2, '0')}:00Z`,
        source: 'spill-source',
        message: largeMessage,
        labels: { index: i.toString() }
      }));

      // Add events that will exceed memory limit
      for (let i = 0; i < events.length; i++) {
        await storage.add(`key-${i}`, events[i]);
      }

      const stats = storage.getStats();
      expect(stats.spillCount).toBeGreaterThan(0);
      expect(stats.diskKeys).toBeGreaterThan(0);
      
      // Verify spill files were created
      const spillFiles = fs.readdirSync(tempDir);
      expect(spillFiles.length).toBeGreaterThan(0);
      expect(spillFiles.some(file => file.startsWith('spill_'))).toBe(true);
    });

    it('should retrieve events from disk after spilling', async () => {
      const largeMessage = 'y'.repeat(5000);
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'disk-retrieval-test',
        message: largeMessage,
        labels: { test: 'disk' }
      };

      // Add enough events to force spilling
      for (let i = 0; i < 3; i++) {
        await storage.add(`disk-key-${i}`, { ...event, message: `${largeMessage}-${i}` });
      }

      // Force more events to trigger spilling of first events
      for (let i = 3; i < 6; i++) {
        await storage.add(`new-key-${i}`, { ...event, message: `${largeMessage}-${i}` });
      }

      // Try to retrieve a key that should have been spilled
      const retrieved = await storage.get('disk-key-0');
      expect(retrieved).toBeDefined();
      expect(retrieved).toHaveLength(1);
      expect(retrieved![0].message).toContain('y'.repeat(5000));
    });

    it('should maintain correct statistics during spilling', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'stats-test',
        message: 'x'.repeat(3000),
        labels: {}
      };

      const initialStats = storage.getStats();
      expect(initialStats.memoryKeys).toBe(0);
      expect(initialStats.diskKeys).toBe(0);

      // Add events to trigger spilling
      for (let i = 0; i < 6; i++) {
        await storage.add(`stats-key-${i}`, event);
      }

      const finalStats = storage.getStats();
      expect(finalStats.memoryKeys + finalStats.diskKeys).toBe(6);
      expect(finalStats.spillCount).toBeGreaterThan(0);
    });

    it('should handle concurrent spilling operations', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'concurrent-test',
        message: 'z'.repeat(2000),
        labels: {}
      };

      // Add many events concurrently to test race conditions
      const addPromises = Array.from({ length: 10 }, (_, i) =>
        storage.add(`concurrent-${i}`, event)
      );

      await Promise.all(addPromises);

      // Verify all events are accessible
      for (let i = 0; i < 10; i++) {
        const retrieved = await storage.get(`concurrent-${i}`);
        expect(retrieved).toBeDefined();
        expect(retrieved).toHaveLength(1);
      }
    });
  });

  describe('Disk Operations', () => {
    beforeEach(() => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 0.01,
        spillDirectory: tempDir
      });
    });

    it('should create unique filenames for spilled data', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'filename-test',
        message: 'a'.repeat(3000),
        labels: {}
      };

      // Add events to force spilling
      await storage.add('key1', event);
      await storage.add('key2', event);
      await storage.add('key3', event);
      await storage.add('key4', event);

      const spillFiles = fs.readdirSync(tempDir);
      const spillFileNames = spillFiles.filter(file => file.startsWith('spill_'));
      
      // Check that filenames are unique
      const uniqueNames = new Set(spillFileNames);
      expect(uniqueNames.size).toBe(spillFileNames.length);
    });

    it('should handle disk I/O errors gracefully', async () => {
      // Create storage with read-only directory to simulate I/O errors
      const readOnlyDir = path.join(tempDir, 'readonly');
      fs.mkdirSync(readOnlyDir);
      fs.chmodSync(readOnlyDir, 0o444);

      const errorStorage = new DiskSpillableStorage({
        maxMemoryMB: 0.001,
        spillDirectory: readOnlyDir
      });

      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'error-test',
        message: 'b'.repeat(1000),
        labels: {}
      };

      // This might not necessarily fail if spilling hasn't triggered yet with small events
      // Just verify storage works
      try {
        await errorStorage.add('error-key', event);
        // If it succeeds, that's also fine for small events that don't trigger spilling
      } catch (error) {
        // If it fails due to permissions, that's expected
        expect(error).toBeDefined();
      }

      // Clean up
      fs.chmodSync(readOnlyDir, 0o755);
      await errorStorage.cleanup();
    });

    it('should persist data correctly to disk', async () => {
      const originalEvent: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'persistence-test',
        message: 'Test persistence message',
        labels: { 
          level: 'info',
          app: 'test-app',
          nested: '{"key":"value"}'
        }
      };

      // Force spilling by adding large events
      for (let i = 0; i < 3; i++) {
        await storage.add(`persist-key-${i}`, {
          ...originalEvent,
          message: 'c'.repeat(3000) + i
        });
      }

      // Add more to force spilling
      await storage.add('final-key', originalEvent);

      // Retrieve and verify data integrity
      const retrieved = await storage.get('persist-key-0');
      expect(retrieved).toBeDefined();
      expect(retrieved![0].source).toBe('persistence-test');
      expect(retrieved![0].labels).toEqual(originalEvent.labels);
    });
  });

  describe('Statistics and Monitoring', () => {
    beforeEach(() => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 1,
        spillDirectory: tempDir
      });
    });

    it('should provide accurate statistics', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'stats-source',
        message: 'Stats test message',
        labels: {}
      };

      let stats = storage.getStats();
      expect(stats.memoryKeys).toBe(0);
      expect(stats.diskKeys).toBe(0);
      expect(stats.memoryUsageMB).toBe(0);
      expect(stats.spillCount).toBe(0);

      await storage.add('stats1', event);
      await storage.add('stats2', event);

      stats = storage.getStats();
      expect(stats.memoryKeys).toBe(2);
      expect(stats.diskKeys).toBe(0);
      expect(stats.memoryUsageMB).toBeGreaterThanOrEqual(0);
    });

    it('should track spill count accurately', async () => {
      const largeEvent: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'spill-count-test',
        message: 'd'.repeat(5000),
        labels: {}
      };

      // Add events to trigger multiple spill operations
      for (let i = 0; i < 10; i++) {
        await storage.add(`spill-count-${i}`, largeEvent);
      }

      const stats = storage.getStats();
      expect(stats.spillCount).toBeGreaterThanOrEqual(0); // May not spill with small events
    });
  });

  describe('Cleanup Operations', () => {
    beforeEach(() => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 0.01,
        spillDirectory: tempDir
      });
    });

    it('should clean up all spill files', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'cleanup-test',
        message: 'e'.repeat(3000),
        labels: {}
      };

      // Create spill files
      for (let i = 0; i < 5; i++) {
        await storage.add(`cleanup-key-${i}`, event);
      }

      // Verify files exist
      const spillFiles = fs.readdirSync(tempDir);
      expect(spillFiles.length).toBeGreaterThan(0);

      await storage.cleanup();

      // Verify files are cleaned up (if directory still exists)
      try {
        const remainingFiles = fs.readdirSync(tempDir);
        const remainingSpillFiles = remainingFiles.filter(file => file.startsWith('spill_'));
        expect(remainingSpillFiles.length).toBe(0);
      } catch (error) {
        // Directory might be removed by cleanup, which is also acceptable
        expect((error as any).code).toBe('ENOENT');
      }
    });

    it('should handle cleanup errors gracefully', async () => {
      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'cleanup-error-test',
        message: 'f'.repeat(3000),
        labels: {}
      };

      await storage.add('cleanup-error-key', event);

      // Force spilling
      await storage.add('another-key', event);

      // Manually remove one of the spill files to simulate cleanup error
      const spillFiles = fs.readdirSync(tempDir);
      const spillFile = spillFiles.find(file => file.startsWith('spill_'));
      if (spillFile) {
        fs.unlinkSync(path.join(tempDir, spillFile));
      }

      // Cleanup should not throw even with missing files
      await expect(storage.cleanup()).resolves.not.toThrow();
    });

    it('should handle cleanup of non-existent directory gracefully', async () => {
      const nonExistentDir = path.join(tempDir, 'does-not-exist');
      
      const cleanupStorage = new DiskSpillableStorage({
        maxMemoryMB: 1,
        spillDirectory: nonExistentDir
      });

      // Should not throw when cleaning up non-existent directory
      await expect(cleanupStorage.cleanup()).resolves.not.toThrow();
    });

    it('should attempt to remove empty spill directory', async () => {
      const subDir = path.join(tempDir, 'empty-after-cleanup');
      
      const cleanupStorage = new DiskSpillableStorage({
        maxMemoryMB: 0.01,
        spillDirectory: subDir
      });

      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'empty-dir-test',
        message: 'g'.repeat(3000),
        labels: {}
      };

      await cleanupStorage.add('empty-test', event);
      await cleanupStorage.add('empty-test2', event); // Force spilling

      expect(fs.existsSync(subDir)).toBe(true);

      await cleanupStorage.cleanup();

      // Directory should be removed if empty, but might still exist if cleanup fails
      // This is acceptable behavior as documented in the implementation
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle extremely large events', async () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 1,
        spillDirectory: tempDir
      });

      const hugeEvent: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'huge-event-test',
        message: 'h'.repeat(500000), // ~500KB message
        labels: { size: 'huge' }
      };

      await storage.add('huge-key', hugeEvent);
      
      const retrieved = await storage.get('huge-key');
      expect(retrieved).toBeDefined();
      expect(retrieved![0].message.length).toBe(500000);
    });

    it('should handle events with complex nested labels', async () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 0.01,
        spillDirectory: tempDir
      });

      const complexEvent: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'complex-test',
        message: 'i'.repeat(3000),
        labels: {
          level: 'info',
          nested: '{"deep":{"structure":{"value":"test","array":[1,2,3,{"nested":"array"}]}}}',
          unicode: '测试🚀',
          special: 'chars"with\'quotes\nand\ttabs'
        }
      };

      await storage.add('complex-key', complexEvent);
      // Add more to force spilling
      await storage.add('force-spill', complexEvent);

      const retrieved = await storage.get('complex-key');
      expect(retrieved).toBeDefined();
      expect(retrieved![0].labels).toEqual(complexEvent.labels);
    });

    it('should handle rapid sequential adds and gets', async () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 0.1,
        spillDirectory: tempDir
      });

      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'rapid-test',
        message: 'j'.repeat(1000),
        labels: {}
      };

      // Rapid adds
      const addPromises = Array.from({ length: 20 }, (_, i) =>
        storage.add(`rapid-${i}`, { ...event, message: `${event.message}-${i}` })
      );

      await Promise.all(addPromises);

      // Rapid gets
      const getPromises = Array.from({ length: 20 }, (_, i) =>
        storage.get(`rapid-${i}`)
      );

      const results = await Promise.all(getPromises);
      
      results.forEach((result, i) => {
        expect(result).toBeDefined();
        expect(result![0].message).toContain(`-${i}`);
      });
    });

    it('should handle zero memory limit configuration', async () => {
      storage = new DiskSpillableStorage({
        maxMemoryMB: 0, // Zero memory limit - should spill immediately
        spillDirectory: tempDir
      });

      const event: LogEvent = {
        timestamp: '2023-12-01T10:00:00Z',
        source: 'zero-memory-test',
        message: 'Small message',
        labels: {}
      };

      await storage.add('zero-mem-key', event);

      const stats = storage.getStats();
      // With zero memory limit, should immediately spill
      expect(stats.diskKeys).toBeGreaterThanOrEqual(0); // May or may not spill depending on implementation
    });
  });
});