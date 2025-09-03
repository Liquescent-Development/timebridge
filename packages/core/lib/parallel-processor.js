"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParallelProcessor = void 0;
const os_1 = require("os");
const eventemitter3_1 = require("eventemitter3");
/**
 * Parallel processing coordinator for CPU-intensive correlation tasks
 */
class ParallelProcessor extends eventemitter3_1.EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.workers = [];
    this.taskQueue = [];
    this.busyWorkers = new Set();
    this.workerRoundRobin = 0;
    this.options.maxWorkers = options.maxWorkers || (0, os_1.cpus)().length;
    this.options.taskQueueSize = options.taskQueueSize || 1000;
  }
  /**
   * Process correlation windows in parallel
   */
  async processWindows(windows, processor) {
    // Split windows into chunks for parallel processing
    const chunkSize = Math.ceil(windows.length / this.options.maxWorkers);
    const chunks = [];
    for (let i = 0; i < windows.length; i += chunkSize) {
      chunks.push(windows.slice(i, i + chunkSize));
    }
    // Process chunks in parallel
    const promises = chunks.map((chunk) => this.processChunk(chunk, processor));
    const results = await Promise.all(promises);
    // Flatten results
    return results.flat();
  }
  /**
   * Process multiple streams in parallel
   */
  async *processStreamsParallel(streams) {
    const buffers = new Map();
    const iterators = new Map();
    // Initialize iterators
    for (const { name, stream } of streams) {
      iterators.set(name, stream[Symbol.asyncIterator]());
      buffers.set(name, []);
    }
    // Process streams in parallel
    while (iterators.size > 0) {
      const promises = [];
      // Start parallel reads
      for (const [name, iterator] of iterators) {
        promises.push(iterator.next().then((result) => ({ name, result })));
      }
      // Wait for at least one to complete
      const results = await Promise.race([
        Promise.all(promises),
        this.raceWithTimeout(promises, 100),
      ]);
      // Process results
      for (const { name, result } of results) {
        if (result.done) {
          iterators.delete(name);
        } else {
          yield { name, event: result.value };
        }
      }
    }
  }
  /**
   * Parallel correlation matching
   */
  async findCorrelationsParallel(leftEvents, rightEvents, joinKeys) {
    const tasks = [];
    const keys = Array.from(leftEvents.keys());
    // Split keys into chunks for parallel processing
    const chunkSize = Math.ceil(keys.length / this.options.maxWorkers);
    for (let i = 0; i < keys.length; i += chunkSize) {
      const keyChunk = keys.slice(i, i + chunkSize);
      tasks.push(
        this.processCorrelationChunk(
          keyChunk,
          leftEvents,
          rightEvents,
          joinKeys
        )
      );
    }
    const results = await Promise.all(tasks);
    return results.flat();
  }
  async processChunk(chunk, processor) {
    const results = [];
    // Process chunk items in parallel with concurrency limit
    const batchSize = Math.min(10, chunk.length);
    for (let i = 0; i < chunk.length; i += batchSize) {
      const batch = chunk.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((item) => processor(item))
      );
      results.push(...batchResults);
    }
    return results;
  }
  async processCorrelationChunk(keys, leftEvents, rightEvents, joinKeys) {
    const correlations = [];
    for (const key of keys) {
      const left = leftEvents.get(key);
      const right = rightEvents.get(key);
      if (left && right) {
        // Create correlation
        const correlation = {
          correlationId: `corr_${Date.now()}_${Math.random()}`,
          timestamp: left[0].timestamp,
          timeWindow: {
            start: left[0].timestamp,
            end: right[right.length - 1].timestamp,
          },
          joinKey: joinKeys[0],
          joinValue: key,
          events: [...left, ...right].map((e) => ({
            source: e.source,
            timestamp: e.timestamp,
            message: e.message,
            labels: e.labels,
          })),
          metadata: {
            completeness: "complete",
            matchedStreams: ["left", "right"],
            totalStreams: 2,
          },
        };
        correlations.push(correlation);
      }
    }
    return correlations;
  }
  async raceWithTimeout(promises, timeoutMs) {
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve([]), timeoutMs);
    });
    return Promise.race([Promise.all(promises), timeout]);
  }
  /**
   * Get current processing statistics
   */
  getStats() {
    return {
      activeWorkers: this.busyWorkers.size,
      totalWorkers: this.workers.length,
      queuedTasks: this.taskQueue.length,
      maxWorkers: this.options.maxWorkers,
    };
  }
  async destroy() {
    // Terminate all workers
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
    this.taskQueue = [];
    this.busyWorkers.clear();
  }
}
exports.ParallelProcessor = ParallelProcessor;
//# sourceMappingURL=parallel-processor.js.map
