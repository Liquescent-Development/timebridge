import { Worker } from "worker_threads";
import { cpus } from "os";
import { EventEmitter } from "eventemitter3";
import { LogEvent, CorrelatedEvent } from "./types";

export interface ParallelProcessorOptions {
  maxWorkers?: number;
  taskQueueSize?: number;
}

interface WorkerTask<T = unknown> {
  id: string;
  type: "correlate" | "deduplicate" | "index";
  data: T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Parallel processing coordinator for CPU-intensive correlation tasks
 */
export class ParallelProcessor extends EventEmitter {
  private workers: Worker[] = [];
  private taskQueue: WorkerTask[] = [];
  private busyWorkers: Set<Worker> = new Set();
  private workerRoundRobin = 0;

  constructor(private options: ParallelProcessorOptions = {}) {
    super();
    this.options.maxWorkers = options.maxWorkers || cpus().length;
    this.options.taskQueueSize = options.taskQueueSize || 1000;
  }

  /**
   * Process correlation windows in parallel
   */
  async processWindows<T>(
    windows: T[],
    processor: (window: T) => Promise<any>
  ): Promise<any[]> {
    // Split windows into chunks for parallel processing
    const chunkSize = Math.ceil(windows.length / this.options.maxWorkers!);
    const chunks: T[][] = [];

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
  async *processStreamsParallel(
    streams: Array<{ name: string; stream: AsyncIterable<LogEvent> }>
  ): AsyncGenerator<{ name: string; event: LogEvent }> {
    const buffers = new Map<string, LogEvent[]>();
    const iterators = new Map<string, AsyncIterator<LogEvent>>();

    // Initialize iterators
    for (const { name, stream } of streams) {
      iterators.set(name, stream[Symbol.asyncIterator]());
      buffers.set(name, []);
    }

    // Process streams in parallel
    while (iterators.size > 0) {
      const promises: Promise<{
        name: string;
        result: IteratorResult<LogEvent>;
      }>[] = [];

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
  async findCorrelationsParallel(
    leftEvents: Map<string, LogEvent[]>,
    rightEvents: Map<string, LogEvent[]>,
    joinKeys: string[]
  ): Promise<CorrelatedEvent[]> {
    const tasks: Promise<CorrelatedEvent[]>[] = [];
    const keys = Array.from(leftEvents.keys());

    // Split keys into chunks for parallel processing
    const chunkSize = Math.ceil(keys.length / this.options.maxWorkers!);

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

  private async processChunk<T>(
    chunk: T[],
    processor: (item: T) => Promise<any>
  ): Promise<any[]> {
    const results: any[] = [];

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

  private async processCorrelationChunk(
    keys: string[],
    leftEvents: Map<string, LogEvent[]>,
    rightEvents: Map<string, LogEvent[]>,
    joinKeys: string[]
  ): Promise<CorrelatedEvent[]> {
    const correlations: CorrelatedEvent[] = [];

    for (const key of keys) {
      const left = leftEvents.get(key);
      const right = rightEvents.get(key);

      if (left && right) {
        // Create correlation
        const correlation: CorrelatedEvent = {
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

  private async raceWithTimeout<T>(
    promises: Promise<T>[],
    timeoutMs: number
  ): Promise<T[]> {
    const timeout = new Promise<T[]>((resolve) => {
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

  async destroy(): Promise<void> {
    // Terminate all workers
    await Promise.all(this.workers.map((worker) => worker.terminate()));

    this.workers = [];
    this.taskQueue = [];
    this.busyWorkers.clear();
  }
}
