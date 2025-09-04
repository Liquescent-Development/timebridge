import { TimeBridgeEngine } from "./correlation-engine";
import { DataSourceAdapter, LogEvent, CorrelatedEvent, TimeQLResult } from "./types";
import { QueryRouter } from "./query-router";
// @ts-ignore - The query-parser module is available but TypeScript can't find the types
import { PeggyQueryParser } from "@timebridge/timeql-parser/dist/peggy-parser";


/**
 * TimeQL executor that supports both correlation and direct queries
 * Main entry point for TimeBridge query execution
 */
export class TimeQLExecutor {
  private engine: TimeBridgeEngine;
  private adapters: Map<string, DataSourceAdapter>;
  private defaultAdapters: Map<string, string>; // Maps base type (e.g., 'graylog') to default adapter name
  private parser: PeggyQueryParser;
  private router: QueryRouter;

  constructor(options: any = {}) {
    this.engine = new TimeBridgeEngine(options);
    this.adapters = new Map();
    this.defaultAdapters = new Map();
    this.parser = new PeggyQueryParser();
    
    // Initialize QueryRouter with configurable thresholds
    this.router = new QueryRouter({
      timeWindowThreshold: options.timeWindowThreshold || 24 * 60 * 60 * 1000, // 24 hours default
      eventCountThreshold: options.eventCountThreshold || 100000, // 100K events default
      forceEngine: options.forceEngine, // Allow forcing a specific engine
      duckdbBatchSize: options.duckdbBatchSize, // Configurable batch size
      streamJoinerConfig: options
    });
  }

  /**
   * Adds a data source adapter with flexible naming
   * @param name - Can be 'graylog', 'graylog-prod', 'loki-us-east', etc.
   * @param adapter - The adapter instance
   * @param options - Additional options like { isDefault: true }
   */
  addAdapter(
    name: string,
    adapter: DataSourceAdapter,
    options: { isDefault?: boolean } = {}
  ) {
    // Store the adapter
    this.adapters.set(name, adapter);
    this.engine.addAdapter(name, adapter);

    // If this is marked as default, or if it's the first of its type, make it default
    const baseType = name.split("-")[0]; // Extract 'graylog' from 'graylog-prod'
    if (options.isDefault || !this.defaultAdapters.has(baseType)) {
      this.defaultAdapters.set(baseType, name);
    }
  }

  /**
   * Resolves a source name to an adapter
   * Handles both explicit names (graylog-prod) and base types (graylog)
   */
  private resolveAdapter(sourceName: string): DataSourceAdapter | undefined {
    // First, try exact match
    if (this.adapters.has(sourceName)) {
      return this.adapters.get(sourceName);
    }

    // Then, try as a base type using the default
    const defaultName = this.defaultAdapters.get(sourceName);
    if (defaultName) {
      return this.adapters.get(defaultName);
    }

    return undefined;
  }

  /**
   * Executes a query and returns wrapped results with clear type discrimination
   * Automatically detects whether the query is direct (single-stream) or correlation (multi-stream)
   */
  async *execute(query: string): AsyncGenerator<TimeQLResult> {
    // Trim whitespace from multiline queries
    const trimmedQuery = query.trim();
    
    // Use the parser to determine query type
    const isDirect = this.parser.isDirect(trimmedQuery);

    if (isDirect) {
      // Direct query - wrap each event
      for await (const event of this.executeDirect(trimmedQuery)) {
        yield {
          type: 'event' as const,
          data: event
        };
      }
    } else {
      // Correlation query - parse and route through QueryRouter
      const parsedQuery = this.parser.parse(trimmedQuery);
      
      // Use QueryRouter for intelligent engine selection
      const decision = await this.router.decideRoute(parsedQuery);
      console.log(`[QueryRouter] Using ${decision.engine}: ${decision.reason}`);
      
      // Execute through router which handles both StreamJoiner and DuckDB
      for await (const result of this.router.execute(parsedQuery, this.adapters)) {
        // Router now returns TimeQLResult directly
        yield result;
      }
    }
  }

  /**
   * Executes a direct (single-stream) query
   * Use this when you know you're querying a single data source
   */
  async *executeEvents(query: string): AsyncGenerator<LogEvent> {
    const trimmedQuery = query.trim();
    
    // Validate it's actually a direct query
    if (!this.parser.isDirect(trimmedQuery)) {
      throw new Error('Query is a correlation query, use executeCorrelation() instead');
    }
    
    yield* this.executeDirect(trimmedQuery);
  }

  /**
   * Executes a correlation (multi-stream) query
   * Use this when you know you're correlating across data sources
   */
  async *executeCorrelation(query: string): AsyncGenerator<CorrelatedEvent> {
    const trimmedQuery = query.trim();
    
    // Validate it's actually a correlation query
    if (this.parser.isDirect(trimmedQuery)) {
      throw new Error('Query is a direct query, use executeEvents() instead');
    }
    
    yield* this.engine.correlate(trimmedQuery);
  }

  /**
   * Executes a direct (non-correlation) query
   */
  private async *executeDirect(query: string): AsyncGenerator<LogEvent> {
    // Parse the query using the proper TimeQL parser
    const parsed = this.parser.parse(query);
    
    // For direct queries, the stream is in leftStream (see transformParseResult)
    const stream = parsed.leftStream;
    
    if (!stream) {
      throw new Error(`Could not extract stream from direct query: ${query}`);
    }
    
    // Resolve the adapter
    const adapter = this.resolveAdapter(stream.source);
    if (!adapter) {
      throw new Error(`No adapter found for source: ${stream.source}`);
    }
    
    // Create and yield from the stream
    // Each adapter will use its own parser (GraylogParser, LogQLParser, etc.)
    // to parse the selector according to its query language
    const adapterStream = adapter.createStream(stream.selector, { 
      timeRange: stream.timeRange 
    });
    yield* adapterStream;
  }

  /**
   * Gets information about registered adapters
   */
  getAdapterInfo(): { name: string; baseType: string; isDefault: boolean }[] {
    const info: { name: string; baseType: string; isDefault: boolean }[] = [];

    for (const [name] of this.adapters) {
      const baseType = name.split("-")[0];
      const isDefault = this.defaultAdapters.get(baseType) === name;
      info.push({ name, baseType, isDefault });
    }

    return info;
  }

  /**
   * Validates a query without executing it
   */
  validateQuery(query: string): {
    valid: boolean;
    type?: "direct" | "correlation";
    sources?: string[];
    error?: string;
  } {
    try {
      // Trim whitespace from multiline queries
      const trimmedQuery = query.trim();
      
      // Use the parser to validate
      const validation = this.parser.validate(trimmedQuery);
      
      if (!validation.valid) {
        return {
          valid: false,
          error: validation.error,
        };
      }
      
      // Parse to get sources
      const parsed = this.parser.parse(trimmedQuery);
      const sources: string[] = [];
      
      if (parsed.leftStream) {
        sources.push(parsed.leftStream.source);
      }
      if (parsed.rightStream) {
        sources.push(parsed.rightStream.source);
      }
      if (parsed.additionalStreams) {
        sources.push(...parsed.additionalStreams.map((s: any) => s.source));
      }
      
      // Check if all required adapters are available
      const missingSources = sources.filter(
        (source) => !this.resolveAdapter(source)
      );

      if (missingSources.length > 0) {
        return {
          valid: false,
          error: `Missing adapters for sources: ${missingSources.join(", ")}`,
        };
      }

      return {
        valid: true,
        type: validation.details?.type || (parsed.rightStream ? "correlation" : "direct"),
        sources,
      };
    } catch (error) {
      return {
        valid: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Convert a LogEvent to CorrelatedEvent format
   * This is needed when QueryRouter returns LogEvents but we need CorrelatedEvents
   */
  private convertToCorrelation(event: LogEvent): CorrelatedEvent {
    // If the event already has correlation metadata in labels, use it
    const labels = event.labels || {};
    
    return {
      correlationId: labels.correlation_id || `corr-${Date.now()}`,
      timestamp: event.timestamp,
      timeWindow: {
        start: event.timestamp,
        end: event.timestamp
      },
      joinKey: labels.join_key || 'request_id',
      joinValue: labels.join_value || '',
      events: [{
        source: event.source,
        timestamp: event.timestamp,
        message: event.message,
        labels: event.labels
      }],
      metadata: {
        completeness: "complete" as const,
        matchedStreams: labels.matched_streams ? labels.matched_streams.split(',') : [event.source],
        totalStreams: 2
      }
    };
  }
}

// Export convenience function for simple use cases
export async function* query(
  queryString: string,
  adapters: Record<string, DataSourceAdapter>,
  options?: any
): AsyncGenerator<TimeQLResult> {
  const executor = new TimeQLExecutor(options);

  // Register all adapters
  for (const [name, adapter] of Object.entries(adapters)) {
    executor.addAdapter(name, adapter);
  }

  yield* executor.execute(queryString);
}
