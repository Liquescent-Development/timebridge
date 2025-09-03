import { EventEmitter } from "events";
import { GrafanaQueryRequest, GrafanaQueryResponse } from "./grafana-datasource-proxy";

export interface BatchOptions {
  maxBatchSize?: number;
  batchTimeout?: number;
  maxConcurrent?: number;
}

export interface QueuedQuery {
  id: string;
  request: GrafanaQueryRequest;
  resolve: (response: GrafanaQueryResponse) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

export interface BatchStats {
  totalBatches: number;
  totalQueries: number;
  averageBatchSize: number;
  currentQueueSize: number;
  activeBatches: number;
}

/**
 * Batches multiple queries to reduce API calls
 */
export class QueryBatcher extends EventEmitter {
  private queue: QueuedQuery[];
  private batchTimer?: NodeJS.Timeout;
  private options: Required<BatchOptions>;
  private stats: BatchStats;
  private activeBatches: Set<string>;
  private queryIdCounter: number;

  constructor(options: BatchOptions = {}) {
    super();
    
    this.options = {
      maxBatchSize: 10,
      batchTimeout: 100, // 100ms default
      maxConcurrent: 3,
      ...options,
    };

    this.queue = [];
    this.activeBatches = new Set();
    this.queryIdCounter = 0;
    this.stats = {
      totalBatches: 0,
      totalQueries: 0,
      averageBatchSize: 0,
      currentQueueSize: 0,
      activeBatches: 0,
    };
  }

  /**
   * Add a query to the batch queue
   */
  async addQuery(request: GrafanaQueryRequest): Promise<GrafanaQueryResponse> {
    return new Promise((resolve, reject) => {
      const query: QueuedQuery = {
        id: `query_${++this.queryIdCounter}`,
        request,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.queue.push(query);
      this.stats.currentQueueSize = this.queue.length;
      
      this.emit("query-added", query.id);
      
      // Check if we should process immediately
      if (this.queue.length >= this.options.maxBatchSize) {
        this.processBatch();
      } else {
        this.scheduleBatch();
      }
    });
  }

  /**
   * Schedule batch processing
   */
  private scheduleBatch(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, this.options.batchTimeout);
  }

  /**
   * Process a batch of queries
   */
  private async processBatch(): Promise<void> {
    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Check if we can process more batches
    if (this.activeBatches.size >= this.options.maxConcurrent) {
      this.scheduleBatch();
      return;
    }

    // Get batch of queries
    const batch = this.queue.splice(0, this.options.maxBatchSize);
    if (batch.length === 0) return;

    const batchId = `batch_${Date.now()}`;
    this.activeBatches.add(batchId);
    
    // Update stats
    this.stats.totalBatches++;
    this.stats.totalQueries += batch.length;
    this.stats.averageBatchSize = this.stats.totalQueries / this.stats.totalBatches;
    this.stats.currentQueueSize = this.queue.length;
    this.stats.activeBatches = this.activeBatches.size;

    this.emit("batch-start", batchId, batch.length);

    try {
      // Merge queries into a single request
      const mergedRequest = this.mergeQueries(batch.map(q => q.request));
      
      // Execute merged request (this would be done by the actual HTTP client)
      const response = await this.executeMergedQuery(mergedRequest);
      
      // Split response and resolve individual queries
      this.distributeResponses(batch, response);
      
      this.emit("batch-complete", batchId);
    } catch (error) {
      // Reject all queries in batch
      for (const query of batch) {
        query.reject(error as Error);
      }
      
      this.emit("batch-error", batchId, error);
    } finally {
      this.activeBatches.delete(batchId);
      this.stats.activeBatches = this.activeBatches.size;
      
      // Process next batch if queued
      if (this.queue.length > 0) {
        this.scheduleBatch();
      }
    }
  }

  /**
   * Merge multiple query requests
   */
  private mergeQueries(requests: GrafanaQueryRequest[]): GrafanaQueryRequest {
    const merged: GrafanaQueryRequest = {
      queries: [],
      from: requests[0].from,
      to: requests[0].to,
    };

    // Find common time range
    for (const request of requests) {
      // Adjust time range to encompass all queries
      if (request.from < merged.from) merged.from = request.from;
      if (request.to > merged.to) merged.to = request.to;
      
      // Add all queries with unique refIds
      for (let i = 0; i < request.queries.length; i++) {
        const query = { ...request.queries[i] };
        // Ensure unique refId across batch
        query.refId = `${query.refId}_${requests.indexOf(request)}_${i}`;
        merged.queries.push(query);
      }
    }

    return merged;
  }

  /**
   * Execute merged query (placeholder - would be replaced with actual HTTP call)
   */
  private async executeMergedQuery(request: GrafanaQueryRequest): Promise<GrafanaQueryResponse> {
    // This would be replaced with actual HTTP execution
    // For now, return a mock response structure
    return {
      results: {},
    };
  }

  /**
   * Distribute responses to individual queries
   */
  private distributeResponses(batch: QueuedQuery[], response: GrafanaQueryResponse): void {
    // Split the merged response back to individual queries
    for (let i = 0; i < batch.length; i++) {
      const query = batch[i];
      const individualResponse: GrafanaQueryResponse = {
        results: {},
      };

      // Extract relevant results for this query
      for (const [key, value] of Object.entries(response.results)) {
        if (key.includes(`_${i}_`)) {
          // Restore original refId
          const originalRefId = key.split("_")[0];
          individualResponse.results[originalRefId] = value;
        }
      }

      query.resolve(individualResponse);
    }
  }

  /**
   * Get current statistics
   */
  getStats(): BatchStats {
    return { ...this.stats };
  }

  /**
   * Clear the queue
   */
  clear(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Reject all pending queries
    for (const query of this.queue) {
      query.reject(new Error("Query batcher cleared"));
    }

    this.queue = [];
    this.stats.currentQueueSize = 0;
  }

  /**
   * Destroy the batcher
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
  }
}

/**
 * Stream optimizer for response processing
 */
export class StreamOptimizer {
  private bufferSize: number;
  private compressionEnabled: boolean;

  constructor(bufferSize = 8192, compressionEnabled = true) {
    this.bufferSize = bufferSize;
    this.compressionEnabled = compressionEnabled;
  }

  /**
   * Create an optimized async iterator
   */
  async *optimize<T>(source: AsyncIterable<T>): AsyncIterable<T> {
    const buffer: T[] = [];
    
    for await (const item of source) {
      buffer.push(item);
      
      // Yield buffered items
      if (buffer.length >= this.bufferSize) {
        yield* buffer;
        buffer.length = 0;
      }
    }

    // Yield remaining items
    if (buffer.length > 0) {
      yield* buffer;
    }
  }

  /**
   * Apply backpressure to prevent memory overload
   */
  async *withBackpressure<T>(
    source: AsyncIterable<T>,
    maxBufferSize = 1000,
    pauseThreshold = 0.8,
    resumeThreshold = 0.5
  ): AsyncIterable<T> {
    let buffer: T[] = [];
    let paused = false;
    let finished = false;
    
    // Start consuming source
    const consume = async () => {
      for await (const item of source) {
        buffer.push(item);
        
        // Check if we should pause
        if (buffer.length >= maxBufferSize * pauseThreshold && !paused) {
          paused = true;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        // Wait while paused
        while (paused && buffer.length > maxBufferSize * resumeThreshold) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        paused = false;
      }
      finished = true;
    };

    // Start consuming in background
    consume().catch(console.error);

    // Yield items from buffer
    while (!finished || buffer.length > 0) {
      if (buffer.length > 0) {
        const batch = buffer.splice(0, Math.min(100, buffer.length));
        yield* batch;
        
        // Resume if below threshold
        if (buffer.length < maxBufferSize * resumeThreshold) {
          paused = false;
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  /**
   * Chunk stream into fixed-size batches
   */
  async *chunk<T>(source: AsyncIterable<T>, chunkSize: number): AsyncIterable<T[]> {
    let chunk: T[] = [];
    
    for await (const item of source) {
      chunk.push(item);
      
      if (chunk.length >= chunkSize) {
        yield chunk;
        chunk = [];
      }
    }
    
    if (chunk.length > 0) {
      yield chunk;
    }
  }

  /**
   * Apply rate limiting to stream
   */
  async *rateLimit<T>(
    source: AsyncIterable<T>,
    itemsPerSecond: number
  ): AsyncIterable<T> {
    const delayMs = 1000 / itemsPerSecond;
    let lastEmit = 0;
    
    for await (const item of source) {
      const now = Date.now();
      const timeSinceLastEmit = now - lastEmit;
      
      if (timeSinceLastEmit < delayMs) {
        await new Promise(resolve => setTimeout(resolve, delayMs - timeSinceLastEmit));
      }
      
      lastEmit = Date.now();
      yield item;
    }
  }
}