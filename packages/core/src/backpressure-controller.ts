import { EventEmitter } from "eventemitter3";

export interface BackpressureOptions {
  highWaterMark: number;
  lowWaterMark: number;
  maxBufferSize: number;
}

export class BackpressureController extends EventEmitter {
  private buffer: any[] = [];
  private isPaused = false;
  private metrics = {
    totalProcessed: 0,
    totalDropped: 0,
    currentBufferSize: 0,
    pauseCount: 0,
    resumeCount: 0,
  };

  constructor(private options: BackpressureOptions) {
    super();
  }

  async *controlFlow<T>(
    source: AsyncIterable<T>,
    processor: (item: T) => Promise<void>
  ): AsyncGenerator<T> {
    for await (const item of source) {
      // Check buffer size
      if (this.buffer.length >= this.options.highWaterMark) {
        this.pause();
      }

      // Add to buffer if not at max capacity
      if (this.buffer.length < this.options.maxBufferSize) {
        this.buffer.push(item);
        this.metrics.currentBufferSize = this.buffer.length;
      } else {
        // Drop event if buffer is full
        this.metrics.totalDropped++;
        this.emit("eventDropped", item);
        continue;
      }

      // Process items from buffer when below low water mark
      while (this.buffer.length > 0 && !this.isPaused) {
        const bufferedItem = this.buffer.shift()!;
        this.metrics.currentBufferSize = this.buffer.length;

        try {
          await processor(bufferedItem);
          this.metrics.totalProcessed++;
          yield bufferedItem;
        } catch (error) {
          this.emit("processingError", { item: bufferedItem, error });
        }

        // Resume if buffer is below low water mark
        if (this.isPaused && this.buffer.length <= this.options.lowWaterMark) {
          this.resume();
        }
      }
    }

    // Process remaining items in buffer
    while (this.buffer.length > 0) {
      const bufferedItem = this.buffer.shift()!;
      await processor(bufferedItem);
      yield bufferedItem;
    }
  }

  private pause(): void {
    if (!this.isPaused) {
      this.isPaused = true;
      this.metrics.pauseCount++;
      this.emit("paused", { bufferSize: this.buffer.length });
    }
  }

  private resume(): void {
    if (this.isPaused) {
      this.isPaused = false;
      this.metrics.resumeCount++;
      this.emit("resumed", { bufferSize: this.buffer.length });
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  clear(): void {
    this.buffer = [];
    this.metrics.currentBufferSize = 0;
    this.isPaused = false;
  }
}
