import { EventEmitter } from "eventemitter3";
export interface BackpressureOptions {
  highWaterMark: number;
  lowWaterMark: number;
  maxBufferSize: number;
}
export declare class BackpressureController extends EventEmitter {
  private options;
  private buffer;
  private isPaused;
  private metrics;
  constructor(options: BackpressureOptions);
  controlFlow<T>(
    source: AsyncIterable<T>,
    processor: (item: T) => Promise<void>
  ): AsyncGenerator<T>;
  private pause;
  private resume;
  getMetrics(): {
    totalProcessed: number;
    totalDropped: number;
    currentBufferSize: number;
    pauseCount: number;
    resumeCount: number;
  };
  clear(): void;
}
//# sourceMappingURL=backpressure-controller.d.ts.map
