import { ParsedQuery, LogEvent, CorrelatedEvent } from './types';
import { StreamJoiner } from './stream-joiner';
import { DuckDBExecutor } from './duckdb-executor';
import { TimeQLToSQLGenerator } from './timeql-to-sql';
import { QueryOptimizer } from './query-optimizer';
import { BloomFilter } from './bloom-filter-wrapper';
import { EventEmitter } from 'eventemitter3';
import { routerLogger, optimizerLogger } from './logger';

export interface QueryRouterConfig {
  /**
   * Time window threshold in milliseconds.
   * Queries with windows larger than this use DuckDB.
   * Default: 24 hours
   */
  timeWindowThreshold?: number;
  
  /**
   * Event count threshold.
   * Queries estimated to return more events than this use DuckDB.
   * Default: 100,000
   */
  eventCountThreshold?: number;
  
  /**
   * Force a specific execution engine
   */
  forceEngine?: 'streamjoiner' | 'duckdb';
  
  /**
   * DuckDB executor instance
   */
  duckdb?: DuckDBExecutor;
  
  /**
   * StreamJoiner configuration
   */
  streamJoinerConfig?: any;
  
  /**
   * Batch size for DuckDB ingestion
   * Default: 1,000,000 events
   */
  duckdbBatchSize?: number;
  
  /**
   * Enable semi-join optimization for asymmetric correlations
   * Default: true
   */
  enableSemiJoinOptimization?: boolean;
  
  /**
   * Threshold for using Bloom filter vs IN list in semi-join
   * Default: 10,000 keys
   */
  bloomFilterThreshold?: number;
  
  /**
   * Maximum time to wait for a stream to complete before optimization
   * Default: 30 seconds
   */
  semiJoinOptimizationDelay?: number;
}

export interface RoutingDecision {
  engine: 'streamjoiner' | 'duckdb';
  reason: string;
  estimatedEvents?: number;
  timeWindowMs?: number;
}

interface StreamProgress {
  streamId: 'left' | 'right';
  eventsProcessed: number;
  isComplete: boolean;
  isAborted?: boolean;
  uniqueJoinKeys: Set<string>;
  startTime: number;
  lastUpdateTime: number;
}

interface SemiJoinOptimization {
  targetStream: 'left' | 'right';
  filterType: 'bloom' | 'in_list' | 'batched_keys';
  filter: BloomFilter | Set<string>;
  joinKey: string;
  originalQuery: any;
  optimizedQuery: any;
  timeBounds?: { min: Date; max: Date };
  completedEvents?: LogEvent[];
}

/**
 * Routes queries between StreamJoiner (in-memory) and DuckDB (scale-out)
 * with advanced optimizations including semi-join for asymmetric correlations.
 */
export class QueryRouter extends EventEmitter {
  private config: QueryRouterConfig;
  private streamJoiner: StreamJoiner;
  private duckdb: DuckDBExecutor;
  private sqlGenerator: TimeQLToSQLGenerator;
  private optimizer: QueryOptimizer;
  private activeStreams: Map<string, StreamProgress>;
  private streamAbortControllers: Map<string, AbortController>;

  constructor(config: QueryRouterConfig = {}) {
    super();
    
    this.config = {
      timeWindowThreshold: config.timeWindowThreshold || 24 * 60 * 60 * 1000, // 24 hours
      eventCountThreshold: config.eventCountThreshold || 100000, // 100K events
      forceEngine: config.forceEngine,
      duckdb: config.duckdb || new DuckDBExecutor(),
      streamJoinerConfig: config.streamJoinerConfig || {},
      enableSemiJoinOptimization: config.enableSemiJoinOptimization ?? true,
      bloomFilterThreshold: config.bloomFilterThreshold || 900, // Switch to Bloom filter before hitting Graylog's limit
      semiJoinOptimizationDelay: config.semiJoinOptimizationDelay || 30000,
      duckdbBatchSize: config.duckdbBatchSize || 1000000
    };
    
    this.streamJoiner = new StreamJoiner(this.config.streamJoinerConfig);
    this.duckdb = this.config.duckdb || new DuckDBExecutor();
    this.sqlGenerator = new TimeQLToSQLGenerator();
    this.optimizer = new QueryOptimizer();
    this.activeStreams = new Map();
    this.streamAbortControllers = new Map();
  }

  /**
   * Decide which engine to use for a query
   */
  async decideRoute(query: ParsedQuery): Promise<RoutingDecision> {
    // Check for forced routing
    if (this.config.forceEngine) {
      return {
        engine: this.config.forceEngine,
        reason: `Forced by configuration`
      };
    }
    
    // Check for query hints
    const hint = this.extractQueryHint(query);
    if (hint) {
      return {
        engine: hint,
        reason: `Forced by query hint`
      };
    }
    
    // Calculate time window
    const timeWindowMs = this.calculateTimeWindow(query);
    
    // Use DuckDB for large time windows
    const timeThreshold = this.config.timeWindowThreshold || 24 * 60 * 60 * 1000;
    if (timeWindowMs > timeThreshold) {
      return {
        engine: 'duckdb',
        reason: `Time window (${Math.round(timeWindowMs / 1000 / 60 / 60)}h) exceeds threshold`,
        timeWindowMs
      };
    }
    
    // Estimate result size
    const optimization = this.optimizer.optimize(query);
    const estimatedEvents = optimization.estimatedEvents || 0;
    
    // Use DuckDB for large result sets
    const eventThreshold = this.config.eventCountThreshold || 100000;
    if (estimatedEvents > eventThreshold) {
      return {
        engine: 'duckdb',
        reason: `Estimated events (${estimatedEvents}) exceeds threshold`,
        estimatedEvents
      };
    }
    
    // Default to StreamJoiner for small, recent queries
    return {
      engine: 'streamjoiner',
      reason: 'Small query suitable for in-memory processing',
      estimatedEvents,
      timeWindowMs
    };
  }

  /**
   * Execute a query using the appropriate engine
   */
  async *execute(query: ParsedQuery, adapters: Map<string, any>): AsyncIterable<CorrelatedEvent> {
    const decision = await this.decideRoute(query);
    
    // Log routing decision for debugging
    routerLogger.info({ engine: decision.engine, reason: decision.reason }, "Engine decision made");
    
    if (decision.engine === 'duckdb') {
      yield* this.executeWithDuckDB(query, adapters);
    } else {
      yield* this.executeWithStreamJoiner(query, adapters);
    }
  }

  /**
   * Execute query using StreamJoiner (in-memory)
   */
  private async *executeWithStreamJoiner(
    query: ParsedQuery, 
    adapters: Map<string, any>
  ): AsyncIterable<CorrelatedEvent> {
    // Get streams from adapters
    const leftAdapter = adapters.get(query.leftStream.source);
    const rightAdapter = query.rightStream ? adapters.get(query.rightStream.source) : null;
    
    if (!leftAdapter) {
      throw new Error(`Adapter not found for source: ${query.leftStream.source}`);
    }
    
    // Create streams
    const leftStream = leftAdapter.createStream(
      query.leftStream.selector,
      { 
        timeRange: query.leftStream.timeRange,
        streamName: query.leftStream.stream
      }
    );
    
    const rightStream = rightAdapter && query.rightStream ? 
      rightAdapter.createStream(
        query.rightStream.selector,
        { 
          timeRange: query.rightStream.timeRange,
          streamName: query.rightStream.stream
        }
      ) : null;
    
    // Execute correlation
    if (rightStream && query.rightStream) {
      yield* this.streamJoiner.join(leftStream, rightStream);
    } else {
      // Single stream query
      for await (const event of leftStream) {
        yield {
          correlationId: event.labels?.correlation_id || 'single-' + Date.now(),
          timestamp: event.timestamp,
          timeWindow: {
            start: event.timestamp,
            end: event.timestamp
          },
          joinKey: 'none',
          joinValue: 'none',
          events: [{
            source: event.source,
            timestamp: event.timestamp,
            message: event.message,
            labels: event.labels
          }],
          metadata: {
            completeness: 'partial' as const,
            matchedStreams: [event.source],
            totalStreams: 1
          }
        };
      }
    }
  }

  /**
   * Execute query using DuckDB with semi-join optimization
   */
  private async *executeWithDuckDB(
    query: ParsedQuery,
    adapters: Map<string, any>
  ): AsyncIterable<CorrelatedEvent> {
    // Initialize DuckDB if needed
    await this.duckdb.initialize();
    
    // Ensure columns exist for the join keys in this query
    const joinKeys = query.joinKeys || [];
    if (joinKeys.length > 0) {
      routerLogger.info({ joinKeys }, "Ensuring join key columns exist in DuckDB");
      await this.duckdb.ensureJoinKeyColumns(joinKeys);
    }
    
    // Clear previous stream tracking
    this.activeStreams.clear();
    this.streamAbortControllers.clear();
    
    routerLogger.info('Starting optimized DuckDB execution with semi-join support');
    
    // Initialize stream progress tracking
    const leftStreamId = 'left';
    const rightStreamId = 'right';
    
    this.activeStreams.set(leftStreamId, {
      streamId: 'left',
      eventsProcessed: 0,
      isComplete: false,
      uniqueJoinKeys: new Set(),
      startTime: Date.now(),
      lastUpdateTime: Date.now()
    });
    
    if (query.rightStream) {
      this.activeStreams.set(rightStreamId, {
        streamId: 'right',
        eventsProcessed: 0,
        isComplete: false,
        uniqueJoinKeys: new Set(),
        startTime: Date.now(),
        lastUpdateTime: Date.now()
      });
    }
    
    // Create abort controllers for stream cancellation
    const leftAbortController = new AbortController();
    const rightAbortController = new AbortController();
    this.streamAbortControllers.set(leftStreamId, leftAbortController);
    this.streamAbortControllers.set(rightStreamId, rightAbortController);
    
    // Start parallel ingestion with stream coordination
    const ingestionPromises = [];
    
    // Start left stream ingestion
    const leftPromise = this.ingestStreamWithTracking(
      query.leftStream,
      adapters,
      'left',
      query.joinKeys || [],
      leftAbortController.signal
    );
    ingestionPromises.push(leftPromise);
    
    // Start right stream ingestion in parallel if present
    if (query.rightStream) {
      const rightPromise = this.ingestStreamWithTracking(
        query.rightStream,
        adapters,
        'right',
        query.joinKeys || [],
        rightAbortController.signal
      );
      ingestionPromises.push(rightPromise);
    }
    
    // Monitor for semi-join optimization opportunity
    let semiJoinOptimization: SemiJoinOptimization | null = null;
    let optimizationPromise: Promise<void> | null = null;
    
    if (this.config.enableSemiJoinOptimization && query.rightStream) {
      // Start monitoring in the background
      const monitorPromise = this.monitorForSemiJoinOptimization(query).then(async optimization => {
        if (optimization) {
          semiJoinOptimization = optimization;
          optimizerLogger.info({ filterType: optimization.filterType, targetStream: optimization.targetStream }, "Semi-join optimization triggered");
          
          // Apply the optimization and wait for it to complete
          await this.applySemiJoinOptimization(optimization, adapters, query);
          
          // For batched queries, ensure the target stream progress is marked complete
          const targetProgress = this.activeStreams.get(optimization.targetStream);
          if (targetProgress && !targetProgress.isComplete) {
            optimizerLogger.warn({ targetStream: optimization.targetStream }, "Target stream not marked complete after optimization - fixing");
            targetProgress.isComplete = true;
            targetProgress.lastUpdateTime = Date.now();
          }
          
          optimizerLogger.info({ 
            targetStream: optimization.targetStream, 
            streamComplete: targetProgress?.isComplete,
            eventsProcessed: targetProgress?.eventsProcessed || 0
          }, "Semi-join optimization completed");
        }
      });
      
      // Store the promise so we can wait for it later
      optimizationPromise = monitorPromise;
    }
    
    // Wait for initial ingestion to complete
    const ingestionResults = await Promise.allSettled(ingestionPromises);
    
    // Wait for optimization to complete if it was triggered
    if (optimizationPromise) {
      optimizerLogger.info("Waiting for semi-join optimization to complete");
      await optimizationPromise;
      optimizerLogger.info("Semi-join optimization promise resolved");
    }
    
    // Check if any stream failed
    const failedStreams = ingestionResults.filter(r => r.status === 'rejected');
    if (failedStreams.length > 0 && !semiJoinOptimization) {
      throw new Error(`Stream ingestion failed: ${failedStreams[0]}`);
    }
    
    const successfulResults = ingestionResults
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .map(r => r.value);
    
    routerLogger.info({ totalEvents: successfulResults.reduce((a,b) => a+b, 0) }, "Ingestion complete");
    
    // Log optimization statistics if applied
    if (semiJoinOptimization) {
      const stats = await this.getSemiJoinStats(semiJoinOptimization);
      optimizerLogger.info({ stats }, "Semi-join optimization stats");
    }
    
    // Generate and execute correlation SQL
    const sql = this.sqlGenerator.generateSQL(query);
    routerLogger.info('Executing correlation query');
    
    const queryResults = await this.duckdb.execute(sql);
    routerLogger.info({ resultCount: queryResults.length }, "Query completed");
    
    // Convert results to CorrelatedEvents
    yield* this.processQueryResults(queryResults, query);
  }

  /**
   * Ingest a stream with progress tracking and join key collection
   */
  private async ingestStreamWithTracking(
    streamConfig: any,
    adapters: Map<string, any>,
    streamId: 'left' | 'right',
    joinKeys: string[],
    abortSignal: AbortSignal
  ): Promise<number> {
    const sourceName = streamConfig.source.includes(':') 
      ? streamConfig.source.split(':')[0] 
      : streamConfig.source;
    
    const adapter = adapters.get(sourceName);
    if (!adapter) {
      throw new Error(`Adapter not found for source: ${sourceName}`);
    }
    
    routerLogger.info({ streamId }, "Starting stream ingestion");
    routerLogger.info({ streamId, selector: streamConfig.selector, timeRange: streamConfig.timeRange }, "Stream configuration");
    
    const progress = this.activeStreams.get(streamId)!;
    
    // Check if adapter supports direct CSV streaming (Graylog adapter)
    if (adapter.streamCSVAsEvents && typeof adapter.streamCSVAsEvents === 'function') {
      // Use direct stream ingestion for CSV data
      routerLogger.info({ streamId, adapter: 'Graylog' }, "Using direct CSV stream ingestion");
      
      try {
        // Stream parsed CSV events directly
        const eventStream = adapter.streamCSVAsEvents(
          streamConfig.selector,
          streamConfig.timeRange,
          joinKeys,
          streamConfig.source
        );
        
        // Transform events to add stream identifier and track progress
        const transformedStream = async function*() {
          let eventCount = 0;
          let buffer: LogEvent[] = [];
          const batchSize = 10000; // Process in smaller batches to check abort signal
          
          for await (const event of eventStream) {
            // Cancel if aborted - check frequently
            if (abortSignal.aborted) {
              routerLogger.info({ streamId, eventCount }, "Stream cancelled by abort signal");
              progress.isAborted = true;
              break;
            }
            
            // Set stream identifier
            event.stream = `${streamId}_stream`;
            
            // Track join keys
            for (const key of joinKeys) {
              const value = event.labels?.[key] || event.joinKeys?.[key];
              if (value) {
                progress.uniqueJoinKeys.add(value);
              }
            }
            
            buffer.push(event);
            eventCount++;
            progress.eventsProcessed = eventCount;
            
            // Yield events in batches and check abort signal
            if (buffer.length >= batchSize) {
              // Update progress
              progress.lastUpdateTime = Date.now();
              routerLogger.debug({ streamId, eventCount, uniqueKeys: progress.uniqueJoinKeys.size }, "Events processed");
              
              // Yield buffered events
              for (const bufferedEvent of buffer) {
                yield bufferedEvent;
              }
              buffer = [];
              
              // Check abort signal again after yielding
              if (abortSignal.aborted) {
                routerLogger.info({ streamId, eventCount }, "Stream cancelled after batch");
                progress.isAborted = true;
                break;
              }
            }
          }
          
          // Yield remaining events if not aborted
          if (!abortSignal.aborted && buffer.length > 0) {
            for (const bufferedEvent of buffer) {
              yield bufferedEvent;
            }
          }
          
          // Mark stream as complete after all events are yielded
          progress.eventsProcessed = eventCount;
          progress.isComplete = true;
          progress.lastUpdateTime = Date.now();
          routerLogger.info({ streamId, totalEvents: eventCount, uniqueKeys: progress.uniqueJoinKeys.size }, "Stream ingestion marked complete");
        };
        
        // Ingest events into DuckDB with batching
        let totalIngested = 0;
        for await (const batch of this.duckdb.ingestStream(transformedStream(), {
          batchSize: this.config.duckdbBatchSize || 100000,
          flushInterval: 1000
        })) {
          totalIngested = batch.total;
        }
        
        routerLogger.info({ streamId, totalIngested }, "Stream complete");
        
        // Emit completion event
        this.emit('streamComplete', {
          streamId,
          eventsProcessed: totalIngested,
          uniqueKeys: progress.uniqueJoinKeys.size,
          duration: Date.now() - progress.startTime
        });
        
        return totalIngested;
        
      } catch (error) {
        if (abortSignal.aborted) {
          routerLogger.debug({ streamId }, "Stream cancelled for optimization");
          return 0;
        } else {
          throw error;
        }
      }
      
    } else {
      // Fallback to original streaming method for other adapters
      routerLogger.info({ streamId }, "Using standard ingestion");
      
      const stream = adapter.createStream(
        streamConfig.selector,
        { 
          timeRange: streamConfig.timeRange,
          correlationKeys: joinKeys,
          sourceName: streamConfig.source,
          streamName: streamConfig.stream,
          abortSignal: abortSignal
        }
      );
      
      let totalEvents = 0;
      let buffer: LogEvent[] = [];
      const batchSize = this.config.duckdbBatchSize || 1000000;
      
      try {
        for await (const event of stream) {
          // Check if aborted
          if (abortSignal.aborted) {
            routerLogger.debug({ streamId }, "Stream aborted for optimization");
            break;
          }
          
          // Set stream identifier
          event.stream = `${streamId}_stream`;
          
          // Track join keys
          for (const key of joinKeys) {
            const value = event.labels?.[key] || event.joinKeys?.[key];
            if (value) {
              progress.uniqueJoinKeys.add(value);
            }
          }
          
          buffer.push(event);
          
          // Flush batch when full
          if (buffer.length >= batchSize) {
            await this.flushEventBatch(buffer);
            totalEvents += buffer.length;
            progress.eventsProcessed = totalEvents;
            progress.lastUpdateTime = Date.now();
            buffer = [];
            
            // Emit progress event
            this.emit('streamProgress', {
              streamId,
              eventsProcessed: totalEvents,
              uniqueKeys: progress.uniqueJoinKeys.size
            });
            
            if (totalEvents % 1000000 === 0) {
              routerLogger.debug({ streamId, totalEvents, uniqueKeys: progress.uniqueJoinKeys.size }, "Stream progress");
            }
          }
        }
        
        // Flush remaining events
        if (buffer.length > 0) {
          await this.flushEventBatch(buffer);
          totalEvents += buffer.length;
          progress.eventsProcessed = totalEvents;
        }
        
        progress.isComplete = true;
        progress.lastUpdateTime = Date.now();
        
        routerLogger.info({ streamId, totalEvents, uniqueKeys: progress.uniqueJoinKeys.size }, "Stream complete");
        
        // Emit completion event
        this.emit('streamComplete', {
          streamId,
          eventsProcessed: totalEvents,
          uniqueKeys: progress.uniqueJoinKeys.size,
          duration: Date.now() - progress.startTime
        });
        
      } catch (error) {
        if (abortSignal.aborted) {
          routerLogger.debug({ streamId }, "Stream cancelled for optimization");
        } else {
          throw error;
        }
      }
      
      return totalEvents;
    }
  }

  /**
   * Flush a batch of events to DuckDB
   */
  private async flushEventBatch(events: LogEvent[]): Promise<void> {
    // Use DuckDB's ingestStream method indirectly
    const generator = async function*() {
      for (const event of events) {
        yield event;
      }
    };
    
    for await (const _ of this.duckdb.ingestStream(generator(), { 
      batchSize: events.length,
      flushInterval: 0 
    })) {
      // Progress is handled
    }
  }

  /**
   * Monitor streams for semi-join optimization opportunity
   */
  private async monitorForSemiJoinOptimization(query: ParsedQuery): Promise<SemiJoinOptimization | null> {
    if (!query.rightStream || !query.joinKeys || query.joinKeys.length === 0) {
      return null;
    }
    
    const joinKey = query.joinKeys[0]; // Use first join key
    const checkInterval = 2000; // Check every 2 seconds for faster detection
    
    optimizerLogger.debug({ joinKey, checkInterval }, "Starting semi-join optimization monitoring (will wait until stream completion)");
    
    return new Promise((resolve) => {
      const checkProgress = async () => {
        const leftProgress = this.activeStreams.get('left');
        const rightProgress = this.activeStreams.get('right');
        
        if (!leftProgress || !rightProgress) {
          optimizerLogger.warn("Stream progress not found, cannot optimize");
          resolve(null);
          return;
        }
        
        // Log current progress
        optimizerLogger.debug({
          left: { 
            events: leftProgress.eventsProcessed, 
            complete: leftProgress.isComplete,
            uniqueKeys: leftProgress.uniqueJoinKeys.size 
          },
          right: { 
            events: rightProgress.eventsProcessed, 
            complete: rightProgress.isComplete,
            uniqueKeys: rightProgress.uniqueJoinKeys.size 
          }
        }, "Checking stream progress for optimization opportunity");
        
        // Check if one stream completed while the other is still running
        if (leftProgress.isComplete && !rightProgress.isComplete) {
          // Left completed first - check if optimization makes sense
          
          // If left stream has 0 keys, optimization doesn't make sense for most join types
          if (leftProgress.uniqueJoinKeys.size === 0) {
            // For INNER JOIN: Result will be empty anyway
            // For LEFT JOIN: Result will be empty (no left events to preserve)
            // For ANTI JOIN: Would need all right events
            optimizerLogger.info("Left stream completed with 0 events - skipping optimization");
            
            // For INNER and LEFT joins with empty left stream, we can abort right stream
            if (query.joinType === 'and' || query.joinType === 'inner' || 
                query.joinType === 'or' || query.joinType === 'left') {
              optimizerLogger.info("Aborting right stream early - no correlations possible with empty left stream");
              // Abort the right stream since result will be empty
              const rightController = this.streamAbortControllers.get('right');
              if (rightController) {
                rightController.abort();
              }
            }
            resolve(null);
            return;
          }
          
          // Left completed first - check if optimization makes sense
          const MIN_KEYS_FOR_OPTIMIZATION = 10; // Don't optimize for very small key sets
          
          if (leftProgress.uniqueJoinKeys.size < MIN_KEYS_FOR_OPTIMIZATION) {
            optimizerLogger.info({ 
              uniqueKeys: leftProgress.uniqueJoinKeys.size,
              threshold: MIN_KEYS_FOR_OPTIMIZATION 
            }, "Left stream has too few unique keys, skipping optimization");
            resolve(null);
            return;
          }
          
          // This is safe for ALL join types:
          // - INNER JOIN: We only need right events that match left keys
          // - LEFT JOIN: We only need right events that match left keys (left events already loaded)
          // - ANTI JOIN: We only need to check right events that match left keys
          optimizerLogger.info({ uniqueKeys: leftProgress.uniqueJoinKeys.size }, "Left stream completed first, applying optimization");
          
          // Get the completed events from DuckDB for time bounds extraction
          const completedEvents = await this.getCompletedStreamEvents('left', joinKey);
          
          const optimization = this.createSemiJoinOptimization(
            'right',
            joinKey,
            leftProgress.uniqueJoinKeys,
            query,
            completedEvents
          );
          resolve(optimization);
          
        } else if (rightProgress.isComplete && !leftProgress.isComplete) {
          // Right completed first - check if we can optimize left stream
          
          // IMPORTANT: For LEFT JOIN (or), we CANNOT filter the left stream
          // because we must return ALL left events, even those without matches
          if (query.joinType === 'or' || query.joinType === 'left') {
            optimizerLogger.info("Right stream completed first, but cannot optimize left stream for LEFT JOIN");
            resolve(null);
            return;
          }
          
          // Check if optimization makes sense based on key count
          const MIN_KEYS_FOR_OPTIMIZATION = 10; // Don't optimize for very small key sets
          
          if (rightProgress.uniqueJoinKeys.size < MIN_KEYS_FOR_OPTIMIZATION) {
            optimizerLogger.info({ 
              uniqueKeys: rightProgress.uniqueJoinKeys.size,
              threshold: MIN_KEYS_FOR_OPTIMIZATION 
            }, "Right stream has too few unique keys, skipping optimization");
            resolve(null);
            return;
          }
          
          optimizerLogger.info({ uniqueKeys: rightProgress.uniqueJoinKeys.size }, "Right stream completed first, applying optimization");
          
          // Get the completed events from DuckDB for time bounds extraction
          const completedEvents = await this.getCompletedStreamEvents('right', joinKey);
          
          const optimization = this.createSemiJoinOptimization(
            'left',
            joinKey,
            rightProgress.uniqueJoinKeys,
            query,
            completedEvents
          );
          resolve(optimization);
          
        } else if (leftProgress.isComplete && rightProgress.isComplete) {
          // Both completed - no optimization needed
          optimizerLogger.info("Both streams completed, no optimization applied");
          resolve(null);
          
        } else {
          // Neither stream is complete yet - continue monitoring
          setTimeout(checkProgress, checkInterval);
        }
      };
      
      setTimeout(checkProgress, checkInterval);
    });
  }

  /**
   * Get completed stream events from DuckDB for time bounds extraction
   */
  private async getCompletedStreamEvents(
    streamId: 'left' | 'right',
    joinKey: string
  ): Promise<LogEvent[]> {
    try {
      // Query a sample of events to extract time bounds (limit to 1000 for efficiency)
      const result = await this.duckdb.execute(`
        SELECT DISTINCT 
          ${joinKey} as joinKey,
          timestamp,
          stream,
          labels
        FROM events
        WHERE stream = '${streamId}_stream'
        AND ${joinKey} IS NOT NULL
        LIMIT 1000
      `);
      
      if (result && result.rows) {
        return result.rows.map((row: any) => ({
          timestamp: row.timestamp,
          message: '',
          source: row.stream,
          labels: row.labels || {},
          joinKeys: { [joinKey]: row.joinKey }
        }));
      }
    } catch (error) {
      routerLogger.error({ error }, "Failed to get completed events");
    }
    
    return [];
  }

  /**
   * Create a semi-join optimization configuration
   */
  private createSemiJoinOptimization(
    targetStream: 'left' | 'right',
    joinKey: string,
    joinKeys: Set<string>,
    originalQuery: ParsedQuery,
    completedEvents?: LogEvent[]
  ): SemiJoinOptimization {
    const keyCount = joinKeys.size;
    // For large key sets, use batched parallel queries (most efficient for server-side filtering)
    // For smaller key sets, use simple IN lists
    const useBatchedKeyFilter = keyCount > 100; // Use batched queries for anything over 100 keys
    
    const filterType = useBatchedKeyFilter ? 'batched parallel queries' : 'IN list';
    
    optimizerLogger.info({ keyCount, filterType }, "Creating semi-join optimization");
    
    // Extract time bounds from completed events if provided
    let timeBounds: { min: Date; max: Date } | undefined;
    if (completedEvents && completedEvents.length > 0) {
      const timestamps = completedEvents
        .map(e => new Date(e.timestamp))
        .filter(d => !isNaN(d.getTime()));
      
      if (timestamps.length > 0) {
        timeBounds = {
          min: new Date(Math.min(...timestamps.map(d => d.getTime()))),
          max: new Date(Math.max(...timestamps.map(d => d.getTime())))
        };
        
        // Add some buffer time (1 hour before and after)
        timeBounds.min.setHours(timeBounds.min.getHours() - 1);
        timeBounds.max.setHours(timeBounds.max.getHours() + 1);
        
        optimizerLogger.debug({ minTime: timeBounds.min.toISOString(), maxTime: timeBounds.max.toISOString() }, "Extracted time bounds");
      }
    }
    
    if (useBatchedKeyFilter) {
      // Use batched parallel queries for large key sets (most efficient)
      return {
        targetStream,
        filterType: 'batched_keys',
        filter: joinKeys,
        joinKey,
        originalQuery: targetStream === 'left' ? originalQuery.leftStream : originalQuery.rightStream,
        optimizedQuery: null,
        timeBounds
      };
    } else {
      // Use simple IN list for small key sets
      return {
        targetStream,
        filterType: 'in_list',
        filter: joinKeys,
        joinKey,
        originalQuery: targetStream === 'left' ? originalQuery.leftStream : originalQuery.rightStream,
        optimizedQuery: null,
        timeBounds
      };
    }
  }

  /**
   * Execute batched key queries for efficient filtering
   */
  private async executeBatchedKeyQueries(
    optimization: SemiJoinOptimization,
    streamConfig: any,
    adapters: Map<string, any>,
    query: ParsedQuery,
    existingKeys: Set<string> = new Set()
  ): Promise<void> {
    optimizerLogger.info({ 
      entering: 'executeBatchedKeyQueries',
      targetStream: optimization.targetStream,
      filterType: optimization.filterType,
      existingKeysSize: existingKeys.size
    }, "Entering executeBatchedKeyQueries");
    
    try {
    const allKeys = Array.from(optimization.filter as Set<string>);
    
    // Remove keys we already have from the set we need to fetch
    const missingKeys = allKeys.filter(key => !existingKeys.has(key));
    const keys = missingKeys;
    
    const MAX_KEYS_PER_BATCH = 100; // Max keys per OR condition
    const MAX_PARALLEL_QUERIES = 10; // Max concurrent queries
    
    optimizerLogger.info({ 
      allKeys: allKeys.length, 
      existingKeys: existingKeys.size, 
      missingKeys: keys.length,
      reductionPercent: allKeys.length > 0 ? `${((1 - keys.length / allKeys.length) * 100).toFixed(1)}%` : '0%'
    }, "Calculated missing keys for batched queries");
    
    // If there are no missing keys, we're done!
    if (keys.length === 0) {
      optimizerLogger.info("All required keys already exist in target stream - no additional queries needed");
      
      // Still need to mark progress as complete
      const progress = this.activeStreams.get(optimization.targetStream);
      if (progress) {
        progress.isComplete = true;
        progress.lastUpdateTime = Date.now();
        
        // Count existing events and unique join keys
        try {
          const countResult = await this.duckdb.execute(`
            SELECT 
              COUNT(*) as event_count,
              COUNT(DISTINCT ${optimization.joinKey}) as unique_keys
            FROM events 
            WHERE stream = '${optimization.targetStream}_stream'
            AND ${optimization.joinKey} IS NOT NULL
          `);
          if (countResult && countResult.length > 0) {
            progress.eventsProcessed = countResult[0].event_count;
            // Update unique keys to match what we found
            progress.uniqueJoinKeys = optimization.filter as Set<string>;
          }
        } catch (error) {
          optimizerLogger.warn({ error }, "Failed to count existing events");
        }
      }
      
      optimizerLogger.info({ 
        targetStream: optimization.targetStream, 
        eventCount: progress?.eventsProcessed || 0,
        uniqueKeysFound: progress?.uniqueJoinKeys.size || 0,
        duration: progress ? Date.now() - progress.startTime : 0
      }, "Using existing data - no new queries needed");
      
      return;
    }
    
    routerLogger.info({ keyCount: keys.length, batchCount: Math.ceil(keys.length / MAX_KEYS_PER_BATCH) }, "Starting batched key filtering");
    
    // Create batches of keys
    const batches: string[][] = [];
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_BATCH) {
      batches.push(keys.slice(i, i + MAX_KEYS_PER_BATCH));
    }
    
    // Get the adapter
    const sourceName = streamConfig.source.includes(':') 
      ? streamConfig.source.split(':')[0] 
      : streamConfig.source;
    
    const adapter = adapters.get(sourceName);
    if (!adapter) {
      routerLogger.error({ sourceName }, "Adapter not found for batched queries");
      return;
    }
    
    // IMPORTANT: Clear any existing abort signal from the adapter that may have been set
    // when we cancelled the original stream. This prevents the batch queries from being
    // immediately aborted. We need to completely remove it, not just null it, because
    // the Graylog adapter checks if it exists and if it's aborted.
    if ((adapter as any).abortSignal) {
      optimizerLogger.debug({ 
        hadAbortSignal: true,
        wasAborted: (adapter as any).abortSignal.aborted 
      }, "Removing existing abort signal from adapter before batch queries");
      
      // Delete the property entirely so the adapter won't find it
      delete (adapter as any).abortSignal;
    }
    
    // Format time bounds if available
    let timeFilter = '';
    if (optimization.timeBounds) {
      const minTime = optimization.timeBounds.min.toISOString();
      const maxTime = optimization.timeBounds.max.toISOString();
      
      // For Graylog, use timestamp range
      if (streamConfig.source.startsWith('graylog')) {
        timeFilter = ` AND timestamp:[${minTime} TO ${maxTime}]`;
      }
      
      routerLogger.debug({ minTime, maxTime }, "Using time bounds");
    }
    
    // Process batches with concurrency control
    const results: LogEvent[] = [];
    let processedBatches = 0;
    
    // Function to process a single batch
    const processBatch = async (batch: string[], batchIndex: number) => {
      optimizerLogger.debug({ 
        batchNumber: batchIndex + 1, 
        entering: true,
        batchSize: batch.length,
        firstKey: batch[0],
        lastKey: batch[batch.length - 1]
      }, "Entering processBatch function");
      
      // For Graylog, don't quote UUID values - they should be bare
      const keyList = streamConfig.source.startsWith('graylog') 
        ? batch.join(' OR ')  // No quotes for Graylog UUIDs
        : batch.map(k => `"${k}"`).join(' OR ');  // Quotes for other adapters if needed
      
      // Build the optimized query for this batch
      let batchQuery = `(${streamConfig.selector})`;
      batchQuery += ` AND ${optimization.joinKey}:(${keyList})`;
      batchQuery += timeFilter;
      
      routerLogger.debug({ 
        batchNumber: batchIndex + 1, 
        totalBatches: batches.length, 
        batchSize: batch.length,
        queryLength: batchQuery.length,
        sampleQuery: batchQuery.substring(0, 200) + (batchQuery.length > 200 ? '...' : '')
      }, "Processing batch");
      
      try {
        // Create a stream for this batch - prefer CSV streaming if available
        let batchStream: AsyncIterable<LogEvent>;
        
        optimizerLogger.debug({ 
          batchNumber: batchIndex + 1,
          adapterHasCSV: !!(adapter.streamCSVAsEvents && typeof adapter.streamCSVAsEvents === 'function'),
          adapterType: adapter.constructor?.name || 'Unknown'
        }, "Checking adapter capabilities");
        
        if (adapter.streamCSVAsEvents && typeof adapter.streamCSVAsEvents === 'function') {
          // Use direct CSV streaming (more efficient for Graylog)
          optimizerLogger.debug({ 
            batchNumber: batchIndex + 1, 
            adapter: 'CSV streaming',
            beforeCreate: true
          }, "About to create CSV stream");
          
          try {
            batchStream = adapter.streamCSVAsEvents(
              batchQuery,
              streamConfig.timeRange,
              query.joinKeys || [],
              streamConfig.source
            );
            
            optimizerLogger.debug({ 
              batchNumber: batchIndex + 1,
              streamCreated: true,
              streamType: typeof batchStream
            }, "CSV stream created successfully");
          } catch (streamError) {
            optimizerLogger.error({ 
              batchNumber: batchIndex + 1,
              error: streamError,
              errorMessage: streamError instanceof Error ? streamError.message : String(streamError)
            }, "Failed to create CSV stream");
            throw streamError;
          }
        } else {
          // Fall back to regular streaming
          optimizerLogger.debug({ batchNumber: batchIndex + 1, adapter: 'regular streaming' }, "Using regular streaming for batch");
          batchStream = adapter.createStream(
            batchQuery,
            { 
              timeRange: streamConfig.timeRange,
              correlationKeys: query.joinKeys || [],
              sourceName: streamConfig.source,
              streamName: streamConfig.stream
            }
          );
        }
        
        // Collect events from this batch with timeout
        const batchEvents: LogEvent[] = [];
        const batchTimeout = 30000; // 30 second timeout per batch
        const startTime = Date.now();
        
        optimizerLogger.debug({ 
          batchNumber: batchIndex + 1,
          startingIteration: true
        }, "Starting to iterate over batch stream");
        
        let iterationStarted = false;
        let iterationEnded = false;
        
        try {
          optimizerLogger.debug({ 
            batchNumber: batchIndex + 1,
            aboutToIterate: true
          }, "About to start for-await loop");
          
          for await (const event of batchStream) {
            if (!iterationStarted) {
              iterationStarted = true;
              optimizerLogger.debug({ 
                batchNumber: batchIndex + 1,
                iterationStarted: true,
                firstEvent: true
              }, "For-await loop started, first event received");
            }
            
            batchEvents.push(event);
            
            // Log first event to confirm stream is working
            if (batchEvents.length === 1) {
              optimizerLogger.debug({ 
                batchNumber: batchIndex + 1,
                firstEventReceived: true,
                eventSample: event.message?.substring(0, 100)
              }, "First event received from batch stream");
            }
            
            // Check for timeout
            if (Date.now() - startTime > batchTimeout) {
              routerLogger.warn({ 
                batchNumber: batchIndex + 1, 
                eventsCollected: batchEvents.length,
                timeoutMs: batchTimeout 
              }, "Batch timed out, continuing with partial results");
              break;
            }
          }
          
          iterationEnded = true;
          optimizerLogger.debug({ 
            batchNumber: batchIndex + 1,
            iterationEnded: true,
            eventsCollected: batchEvents.length
          }, "For-await loop completed normally");
          
        } catch (iterError) {
          optimizerLogger.error({ 
            batchNumber: batchIndex + 1,
            error: iterError,
            errorMessage: iterError instanceof Error ? iterError.message : String(iterError),
            errorStack: iterError instanceof Error ? iterError.stack : undefined,
            eventsCollectedSoFar: batchEvents.length,
            iterationStarted,
            iterationEnded
          }, "Error while iterating batch stream");
          // Return what we have so far
        }
        
        if (!iterationStarted) {
          optimizerLogger.warn({ 
            batchNumber: batchIndex + 1,
            warning: "Stream iteration never started"
          }, "Batch stream did not yield any events");
        }
        
        routerLogger.debug({ 
          batchNumber: batchIndex + 1, 
          eventsFound: batchEvents.length,
          duration: Date.now() - startTime
        }, "Batch completed");
        return batchEvents;
        
      } catch (error) {
        routerLogger.error({ batchNumber: batchIndex + 1, error }, "Batch failed");
        return [];
      }
    };
    
    // Process batches with parallelism
    optimizerLogger.info({ 
      totalBatches: batches.length, 
      maxParallelQueries: MAX_PARALLEL_QUERIES,
      keysPerBatch: MAX_KEYS_PER_BATCH 
    }, "Starting parallel batch processing");
    
    for (let i = 0; i < batches.length; i += MAX_PARALLEL_QUERIES) {
      const parallelBatches = batches.slice(i, i + MAX_PARALLEL_QUERIES);
      
      optimizerLogger.info({ 
        batchGroupStart: i, 
        batchGroupEnd: Math.min(i + MAX_PARALLEL_QUERIES - 1, batches.length - 1),
        batchesInGroup: parallelBatches.length 
      }, "Starting batch group");
      
      const batchPromises = parallelBatches.map((batch, idx) => {
        const batchNumber = i + idx;
        optimizerLogger.debug({ batchNumber: batchNumber + 1, keysInBatch: batch.length }, "Starting individual batch");
        return processBatch(batch, batchNumber).catch(error => {
          optimizerLogger.error({ 
            batchNumber: batchNumber + 1, 
            error,
            errorMessage: error instanceof Error ? error.message : String(error)
          }, "Batch promise failed");
          return []; // Return empty array on failure to continue processing other batches
        });
      });
      
      let batchResults: LogEvent[][];
      try {
        batchResults = await Promise.all(batchPromises);
        optimizerLogger.debug({ 
          batchGroupCompleted: true,
          batchesCompleted: batchResults.length,
          eventsCollected: batchResults.reduce((sum, events) => sum + events.length, 0)
        }, "Batch group promises resolved");
      } catch (error) {
        optimizerLogger.error({ 
          batchGroup: i / MAX_PARALLEL_QUERIES,
          error,
          errorMessage: error instanceof Error ? error.message : String(error)
        }, "Failed to await batch promises");
        throw error;
      }
      for (const events of batchResults) {
        results.push(...events);
      }
      
      processedBatches += parallelBatches.length;
      optimizerLogger.debug({ 
        batchesJustCompleted: parallelBatches.length, 
        processedBatchesSoFar: processedBatches,
        resultsCollectedSoFar: results.length 
      }, "Batch group completed");
      
      // Calculate filter effectiveness
      const queriedKeys = processedBatches * MAX_KEYS_PER_BATCH;
      const filterEffectiveness = queriedKeys > 0 ? 
        `${((results.length / queriedKeys) * 100).toFixed(2)} events per key` : '0';
      
      optimizerLogger.info({ 
        processedBatches, 
        totalBatches: batches.length, 
        totalEvents: results.length,
        queriedKeys,
        filterEffectiveness
      }, "Batch processing progress");
    }
    
    // Log completion of all batch processing
    optimizerLogger.debug({ totalBatchesProcessed: processedBatches }, "All batch processing complete");
    
    // Ingest all results into DuckDB
    const overallEffectiveness = keys.length > 0 ? 
      `${((results.length / keys.length) * 100).toFixed(2)} events per key` : '0';
    
    optimizerLogger.info({ 
      totalEvents: results.length, 
      totalKeys: keys.length,
      overallEffectiveness,
      reductionRatio: keys.length > 0 ? `1:${(keys.length / Math.max(results.length, 1)).toFixed(1)}` : '1:1'
    }, "Batched queries complete - ingesting results");
    
    if (results.length > 0) {
      const generator = async function*() {
        for (const event of results) {
          // Set the correct stream identifier for correlation
          event.stream = `${optimization.targetStream}_stream`;
          yield event;
        }
      };
      
      for await (const _ of this.duckdb.ingestStream(generator(), { 
        batchSize: results.length,
        flushInterval: 0 
      })) {
        // Progress is handled
      }
    }
    
    // Mark stream as complete and update progress
    const progress = this.activeStreams.get(optimization.targetStream);
    if (progress) {
      progress.isComplete = true;
      progress.eventsProcessed = results.length;
      progress.lastUpdateTime = Date.now();
      
      // Track unique join keys for correlation stats
      for (const event of results) {
        for (const key of query.joinKeys || []) {
          const value = event.labels?.[key] || event.joinKeys?.[key];
          if (value) {
            progress.uniqueJoinKeys.add(value);
          }
        }
      }
    }
    
    optimizerLogger.info({ 
      targetStream: optimization.targetStream, 
      eventCount: results.length,
      uniqueKeysFound: progress?.uniqueJoinKeys.size || 0,
      duration: progress ? Date.now() - progress.startTime : 0
    }, "Batched optimization complete");
    
    } catch (error) {
      optimizerLogger.error({ 
        targetStream: optimization.targetStream, 
        error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "Failed to execute batched key queries");
      throw error;
    }
  }

  /**
   * Apply semi-join optimization by restarting the incomplete stream with filters
   */
  private async applySemiJoinOptimization(
    optimization: SemiJoinOptimization,
    adapters: Map<string, any>,
    query: ParsedQuery
  ): Promise<void> {
    optimizerLogger.info({ targetStream: optimization.targetStream }, "Applying semi-join optimization");
    
    // Cancel the current stream
    const abortController = this.streamAbortControllers.get(optimization.targetStream);
    if (abortController) {
      routerLogger.debug({ targetStream: optimization.targetStream }, "Cancelling existing stream");
      abortController.abort();
      
      // Mark the stream as aborted in progress tracking
      const progress = this.activeStreams.get(optimization.targetStream);
      if (progress) {
        progress.isAborted = true;
      }
    }
    
    // Wait for the stream to actually stop (check progress tracking)
    let waitTime = 0;
    const maxWaitTime = 5000;
    while (waitTime < maxWaitTime) {
      const progress = this.activeStreams.get(optimization.targetStream);
      if (!progress || progress.isAborted || progress.isComplete) {
        routerLogger.debug({ targetStream: optimization.targetStream }, "Original stream stopped");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      waitTime += 500;
    }
    
    if (waitTime >= maxWaitTime) {
      routerLogger.warn({ maxWaitTime, targetStream: optimization.targetStream }, "Original stream did not stop, proceeding anyway");
    }
    
    // Check what keys we already have for this stream to avoid re-fetching
    let existingKeys = new Set<string>();
    try {
      // DuckDB extraction - try dedicated column first, then JSON
      let existingData: any;
      
      // First, check if we have a dedicated column for this join key
      const checkColumnSQL = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'events' 
        AND column_name = '${optimization.joinKey}'
      `;
      
      const hasColumn = await this.duckdb.execute(checkColumnSQL);
      
      if (hasColumn && hasColumn.length > 0) {
        // Use the dedicated column (fast path)
        optimizerLogger.debug({ joinKey: optimization.joinKey }, "Using dedicated column for existing key check");
        existingData = await this.duckdb.execute(`
          SELECT DISTINCT ${optimization.joinKey} as existing_key
          FROM events 
          WHERE stream = '${optimization.targetStream}_stream'
          AND ${optimization.joinKey} IS NOT NULL
        `);
      } else {
        // Fall back to JSON extraction
        optimizerLogger.debug({ joinKey: optimization.joinKey }, "Using JSON extraction for existing key check");
        try {
          // Try json_extract_string function (DuckDB's standard JSON function)
          existingData = await this.duckdb.execute(`
            SELECT DISTINCT json_extract_string(labels, '$.${optimization.joinKey}') as existing_key
            FROM events 
            WHERE stream = '${optimization.targetStream}_stream'
            AND json_extract_string(labels, '$.${optimization.joinKey}') IS NOT NULL
          `);
        } catch (jsonError) {
          // If JSON extraction fails, log and continue
          optimizerLogger.debug({ joinKey: optimization.joinKey, error: jsonError }, "JSON extraction failed");
          existingData = [];
        }
      }
      
      if (existingData && existingData.length > 0) {
        existingKeys = new Set(existingData.map((row: any) => row.existing_key).filter(Boolean));
        optimizerLogger.info({ 
          targetStream: optimization.targetStream, 
          existingKeys: existingKeys.size,
          originalKeys: (optimization.filter as Set<string>).size,
          reductionPercent: (optimization.filter as Set<string>).size > 0 ? 
            `${((existingKeys.size / (optimization.filter as Set<string>).size) * 100).toFixed(1)}%` : '0%'
        }, "Found existing data for target stream");
      }
    } catch (error) {
      optimizerLogger.warn({ targetStream: optimization.targetStream, error }, "Failed to check existing keys, will clear and refetch all");
    }

    // Only clear data if we don't have useful existing keys, or if there's an overlap concern
    if (existingKeys.size === 0) {
      optimizerLogger.debug({ targetStream: optimization.targetStream }, "No existing useful data found, clearing stream data");
      await this.duckdb.execute(`
        DELETE FROM events 
        WHERE stream = '${optimization.targetStream}_stream'
      `);
    } else {
      optimizerLogger.info({ 
        targetStream: optimization.targetStream, 
        existingKeys: existingKeys.size 
      }, "Keeping existing data, will only fetch missing keys");
    }
    
    // Create optimized query
    const streamConfig = optimization.targetStream === 'left' 
      ? query.leftStream 
      : query.rightStream;
    
    if (!streamConfig) {
      routerLogger.error({ targetStream: optimization.targetStream }, "Stream config not found");
      return;
    }
    
    // Handle batched key filtering
    if (optimization.filterType === 'batched_keys') {
      await this.executeBatchedKeyQueries(
        optimization,
        streamConfig,
        adapters,
        query,
        existingKeys
      );
      return;
    }
    
    let optimizedSelector = streamConfig.selector;
    
    if (optimization.filterType === 'in_list') {
      // Add IN filter to the query - but limit to avoid maxClauseCount issues
      const allKeys = Array.from(optimization.filter as Set<string>);
      const missingKeys = allKeys.filter(key => !existingKeys.has(key));
      const keys = missingKeys;
      
      optimizerLogger.info({ 
        allKeys: allKeys.length, 
        existingKeys: existingKeys.size, 
        missingKeys: keys.length 
      }, "Filtering IN list to only missing keys");
      
      if (keys.length === 0) {
        optimizerLogger.info("All required keys already exist - no additional streaming needed");
        // Mark as complete and return
        const progress = this.activeStreams.get(optimization.targetStream);
        if (progress) {
          progress.isComplete = true;
          progress.lastUpdateTime = Date.now();
        }
        return;
      }
      
      // Should never reach here with > 100 keys, but add safety check
      if (keys.length > 100) {
        routerLogger.warn({ keyCount: keys.length }, "IN list has too many keys, should have used batched queries");
        // Fall back to batched execution
        optimization.filterType = 'batched_keys';
        await this.executeBatchedKeyQueries(
          optimization,
          streamConfig,
          adapters,
          query,
          existingKeys
        );
        return;
      }
      
      // Safe to use IN list in query (100 keys or less)
      // For Graylog, don't quote UUID values - they should be bare
      const keyList = streamConfig.source.startsWith('graylog') 
        ? keys.join(' OR ')  // No quotes for Graylog UUIDs
        : keys.map(k => `"${k}"`).join(' OR ');  // Quotes for other adapters if needed
      
      // For Graylog, add the filter
      if (streamConfig.source.startsWith('graylog')) {
        optimizedSelector = `(${streamConfig.selector}) AND ${optimization.joinKey}:(${keyList})`;
      }
      
      routerLogger.debug({ keyCount: keys.length }, "Added IN list filter to query");
      
      // Update the optimization filter to only include missing keys
      optimization.filter = new Set(keys);
    } else {
      // For Bloom filter, we need to handle it differently since we can't extract keys from it
      // We'll keep the bloom filter but track existing keys separately for client-side deduplication
      if (existingKeys.size > 0) {
        optimizerLogger.info({ existingKeys: existingKeys.size }, "Will skip existing keys during bloom filter processing");
        // We'll check both bloom filter AND existing keys during streaming
      } else {
        optimizerLogger.debug("Will apply Bloom filter during ingestion");
      }
    }
    
    // Create new stream with optimization
    const sourceName = streamConfig.source.includes(':') 
      ? streamConfig.source.split(':')[0] 
      : streamConfig.source;
    
    const adapter = adapters.get(sourceName);
    if (!adapter) {
      routerLogger.error({ sourceName }, "Adapter not found for optimized stream");
      return;
    }
    
    // Create new abort controller for the optimized stream
    const newAbortController = new AbortController();
    this.streamAbortControllers.set(optimization.targetStream, newAbortController);
    
    // Reset progress tracking
    const progress = this.activeStreams.get(optimization.targetStream)!;
    progress.eventsProcessed = 0;
    progress.isComplete = false;
    progress.uniqueJoinKeys.clear();
    progress.startTime = Date.now();
    
    // Start optimized ingestion
    routerLogger.info({ targetStream: optimization.targetStream }, "Starting optimized stream ingestion");
    
    // Use CSV streaming if available, otherwise fall back to regular stream
    let stream: AsyncIterable<LogEvent>;
    if (adapter.streamCSVAsEvents && typeof adapter.streamCSVAsEvents === 'function') {
      routerLogger.debug({ targetStream: optimization.targetStream }, "Using CSV streaming for optimized stream");
      stream = adapter.streamCSVAsEvents(
        optimizedSelector,
        streamConfig.timeRange,
        query.joinKeys || [],
        streamConfig.source
      );
    } else {
      stream = adapter.createStream(
        optimizedSelector,
        { 
          timeRange: streamConfig.timeRange,
          correlationKeys: query.joinKeys || [],
          sourceName: streamConfig.source,
          streamName: streamConfig.stream,
          abortSignal: newAbortController.signal,
          // Pass Bloom filter for adapter-level filtering if supported
          bloomFilter: optimization.filterType === 'bloom' ? optimization.filter : undefined
        }
      );
    }
    
    let totalEvents = 0;
    let filteredEvents = 0;
    let buffer: LogEvent[] = [];
    const batchSize = this.config.duckdbBatchSize || 1000000;
    let lastProgressLog = Date.now();
    const progressInterval = 5000; // Log progress every 5 seconds
    
    // Check if we need client-side filtering for large IN lists
    const needsClientSideFilter = optimization.filterType === 'in_list' && 
                                  (optimization.filter as Set<string>).size > 900;
    
    optimizerLogger.info({ 
      targetStream: optimization.targetStream, 
      filterType: optimization.filterType,
      needsClientSideFilter,
      batchSize,
      existingKeysSkipped: existingKeys.size
    }, "Starting optimized stream processing");
    
    try {
      for await (const event of stream) {
        const keyValue = event.labels?.[optimization.joinKey] || event.joinKeys?.[optimization.joinKey];
        
        // First check if we already have this key (skip duplicates)
        if (keyValue && existingKeys.has(String(keyValue))) {
          filteredEvents++;
          continue; // Skip events we already have
        }
        
        // Apply filtering based on optimization type
        if (optimization.filterType === 'bloom') {
          // Bloom filter approach
          const bloomFilter = optimization.filter as BloomFilter;
          
          if (keyValue && !bloomFilter.mightContain(String(keyValue))) {
            filteredEvents++;
            continue; // Skip events that definitely don't match
          }
        } else if (needsClientSideFilter) {
          // Client-side IN list filtering for large key sets (now only missing keys)
          const keySet = optimization.filter as Set<string>;
          
          if (keyValue && !keySet.has(String(keyValue))) {
            filteredEvents++;
            continue; // Skip events that don't match our missing keys
          }
        }
        
        // Set stream identifier
        event.stream = `${optimization.targetStream}_stream`;
        
        // Track join keys
        for (const key of query.joinKeys || []) {
          const value = event.labels?.[key] || event.joinKeys?.[key];
          if (value) {
            progress.uniqueJoinKeys.add(value);
          }
        }
        
        buffer.push(event);
        totalEvents++;
        
        // Log progress periodically (time-based, not just on batch flush)
        if (Date.now() - lastProgressLog > progressInterval) {
          optimizerLogger.info({ 
            targetStream: optimization.targetStream, 
            totalEvents, 
            filteredEvents,
            filterEffectiveness: totalEvents > 0 ? `${((filteredEvents / (totalEvents + filteredEvents)) * 100).toFixed(1)}%` : '0%',
            uniqueKeys: progress.uniqueJoinKeys.size,
            bufferSize: buffer.length
          }, "Optimized stream processing progress");
          lastProgressLog = Date.now();
        }
        
        // Flush batch when full
        if (buffer.length >= batchSize) {
          optimizerLogger.debug({ targetStream: optimization.targetStream, batchSize }, "Flushing batch to DuckDB");
          await this.flushEventBatch(buffer);
          progress.eventsProcessed = totalEvents;
          progress.lastUpdateTime = Date.now();
          buffer = [];
          
          optimizerLogger.debug({ 
            targetStream: optimization.targetStream, 
            totalEvents, 
            filteredEvents,
            batchesFlushed: Math.ceil(totalEvents / batchSize)
          }, "Batch flushed successfully");
        }
      }
      
      // Flush remaining events
      if (buffer.length > 0) {
        optimizerLogger.debug({ targetStream: optimization.targetStream, remainingEvents: buffer.length }, "Flushing final batch");
        await this.flushEventBatch(buffer);
        progress.eventsProcessed = totalEvents;
      }
      
      progress.isComplete = true;
      progress.lastUpdateTime = Date.now();
      
      const filterEffectiveness = totalEvents + filteredEvents > 0 ? 
        `${((filteredEvents / (totalEvents + filteredEvents)) * 100).toFixed(1)}%` : '0%';
      
      optimizerLogger.info({ 
        targetStream: optimization.targetStream, 
        totalEvents, 
        filteredEvents,
        filterEffectiveness,
        uniqueKeys: progress.uniqueJoinKeys.size,
        duration: Date.now() - progress.startTime
      }, "Optimized stream processing complete");
      
    } catch (error) {
      if (newAbortController.signal.aborted) {
        routerLogger.debug({ targetStream: optimization.targetStream }, "Optimized stream cancelled");
      } else {
        routerLogger.error({ targetStream: optimization.targetStream, error }, "Error in optimized stream");
      }
    }
  }

  /**
   * Get statistics about semi-join optimization
   */
  private async getSemiJoinStats(optimization: SemiJoinOptimization): Promise<any> {
    const stats: any = {
      targetStream: optimization.targetStream,
      filterType: optimization.filterType,
      joinKey: optimization.joinKey
    };
    
    if (optimization.filterType === 'bloom') {
      const bloomFilter = optimization.filter as BloomFilter;
      stats.bloomFilterStats = bloomFilter.getStats();
    } else {
      const keys = optimization.filter as Set<string>;
      stats.inListSize = keys.size;
    }
    
    // Get reduction statistics from DuckDB
    const reductionStats = await this.duckdb.execute(`
      SELECT 
        stream,
        COUNT(*) as event_count,
        COUNT(DISTINCT ${optimization.joinKey}) as unique_keys
      FROM events
      GROUP BY stream
    `);
    
    stats.eventCounts = reductionStats;
    
    return stats;
  }

  /**
   * Process query results into CorrelatedEvents
   */
  private async *processQueryResults(
    queryResults: any[],
    query: ParsedQuery
  ): AsyncGenerator<CorrelatedEvent> {
    // Group results by correlation_id (join value)
    const correlations = new Map<string, {
      joinKey: string;
      joinValue: string;
      events: any[];
      minTimestamp: string;
      maxTimestamp: string;
    }>();
    
    for (const row of queryResults) {
      const correlationId = row.correlation_id;
      
      if (!correlations.has(correlationId)) {
        correlations.set(correlationId, {
          joinKey: row.join_key || query.joinKeys?.[0] || 'unknown',
          joinValue: row.join_value || correlationId,
          events: [],
          minTimestamp: row.window_start || row.left_timestamp,
          maxTimestamp: row.window_end || row.right_timestamp
        });
      }
      
      const correlation = correlations.get(correlationId)!;
      
      // Track unique events to avoid duplicates
      const leftKey = `left-${row.left_timestamp}-${row.left_message}`;
      const rightKey = `right-${row.right_timestamp}-${row.right_message}`;
      const seenEvents = new Set(correlation.events.map(e => `${e.alias}-${e.timestamp}-${e.message}`));
      
      // Add the left event if not already added
      if (row.left_timestamp && row.left_message && !seenEvents.has(leftKey)) {
        const leftLabels = typeof row.left_labels === 'string' ? JSON.parse(row.left_labels) : row.left_labels || {};
        correlation.events.push({
          alias: 'left',
          source: row.left_source || 'unknown',
          timestamp: row.left_timestamp,
          message: row.left_message,
          labels: leftLabels
        });
      }
      
      // Add the right event if not already added
      if (row.right_timestamp && row.right_message && !seenEvents.has(rightKey)) {
        const rightLabels = typeof row.right_labels === 'string' ? JSON.parse(row.right_labels) : row.right_labels || {};
        correlation.events.push({
          alias: 'right',
          source: row.right_source || 'unknown',
          timestamp: row.right_timestamp,
          message: row.right_message,
          labels: rightLabels
        });
      }
      
      // Update time window
      if (row.window_start < correlation.minTimestamp) {
        correlation.minTimestamp = row.window_start;
      }
      if (row.window_end > correlation.maxTimestamp) {
        correlation.maxTimestamp = row.window_end;
      }
    }
    
    // Yield each correlation with all its events
    for (const [correlationId, correlation] of correlations) {
      if (correlation.events.length > 0) {
        const leftCount = correlation.events.filter(e => e.alias === 'left').length;
        const rightCount = correlation.events.filter(e => e.alias === 'right').length;
        
        yield {
          correlationId: correlationId,
          timestamp: correlation.minTimestamp,
          timeWindow: {
            start: correlation.minTimestamp,
            end: correlation.maxTimestamp
          },
          joinKey: correlation.joinKey,
          joinValue: correlation.joinValue,
          events: correlation.events,
          metadata: {
            completeness: (leftCount > 0 && rightCount > 0) ? 'complete' : 'partial',
            matchedStreams: leftCount > 0 && rightCount > 0 ? ['left', 'right'] : leftCount > 0 ? ['left'] : ['right'],
            totalStreams: 2
          }
        };
      }
    }
  }

  /**
   * Extract query hint if present
   */
  private extractQueryHint(query: ParsedQuery): 'streamjoiner' | 'duckdb' | null {
    // Check for hints in query metadata
    if (query.metadata?.engine === 'duckdb') return 'duckdb';
    if (query.metadata?.engine === 'streamjoiner') return 'streamjoiner';
    
    // Could also parse from native query comments
    const nativeQuery = query.leftStream.selector || '';
    if (nativeQuery.includes('/* engine:duckdb */')) return 'duckdb';
    if (nativeQuery.includes('/* engine:streamjoiner */')) return 'streamjoiner';
    
    return null;
  }

  /**
   * Calculate time window in milliseconds
   */
  private calculateTimeWindow(query: ParsedQuery): number {
    const leftWindow = this.parseTimeRange(query.leftStream.timeRange);
    const rightWindow = query.rightStream ? 
      this.parseTimeRange(query.rightStream.timeRange) : 0;
    
    return Math.max(leftWindow, rightWindow);
  }

  /**
   * Parse time range string to milliseconds
   */
  private parseTimeRange(timeRange?: string): number {
    if (!timeRange) return 0;
    
    const match = timeRange.match(/^(\d+)([smhd])$/);
    if (!match) return 0;
    
    const [, value, unit] = match;
    const multipliers: Record<string, number> = {
      's': 1000,
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };
    
    return parseInt(value) * (multipliers[unit] || 0);
  }

  /**
   * Get current stream progress information
   */
  getStreamProgress(): Map<string, StreamProgress> {
    return new Map(this.activeStreams);
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    // Cancel any active streams
    for (const controller of this.streamAbortControllers.values()) {
      controller.abort();
    }
    
    this.activeStreams.clear();
    this.streamAbortControllers.clear();
    this.removeAllListeners();
    
    await this.duckdb.destroy();
  }
}