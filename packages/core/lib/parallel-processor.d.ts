import { EventEmitter } from "eventemitter3";
import { LogEvent, CorrelatedEvent } from "./types";
export interface ParallelProcessorOptions {
  maxWorkers?: number;
  taskQueueSize?: number;
}
/**
 * Parallel processing coordinator for CPU-intensive correlation tasks
 */
export declare class ParallelProcessor extends EventEmitter {
  private options;
  private workers;
  private taskQueue;
  private busyWorkers;
  private workerRoundRobin;
  constructor(options?: ParallelProcessorOptions);
  /**
   * Process correlation windows in parallel
   */
  processWindows<T>(
    windows: T[],
    processor: (window: T) => Promise<any>
  ): Promise<any[]>;
  /**
   * Process multiple streams in parallel
   */
  processStreamsParallel(
    streams: Array<{
      name: string;
      stream: AsyncIterable<LogEvent>;
    }>
  ): AsyncGenerator<{
    name: string;
    event: LogEvent;
  }>;
  /**
   * Parallel correlation matching
   */
  findCorrelationsParallel(
    leftEvents: Map<string, LogEvent[]>,
    rightEvents: Map<string, LogEvent[]>,
    joinKeys: string[]
  ): Promise<CorrelatedEvent[]>;
  private processChunk;
  private processCorrelationChunk;
  private raceWithTimeout;
  /**
   * Get current processing statistics
   */
  getStats(): {
    activeWorkers: number;
    totalWorkers: number;
    queuedTasks: number;
    maxWorkers: number | undefined;
  };
  destroy(): Promise<void>;
}
//# sourceMappingURL=parallel-processor.d.ts.map
