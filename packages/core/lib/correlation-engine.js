"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorrelationEngine = void 0;
const eventemitter3_1 = require("eventemitter3");
const types_1 = require("./types");
const stream_joiner_1 = require("./stream-joiner");
const multi_stream_joiner_1 = require("./multi-stream-joiner");
const backpressure_controller_1 = require("./backpressure-controller");
const performance_monitor_1 = require("./performance-monitor");
const utils_1 = require("./utils");
const log_correlator_query_parser_1 = require("@liquescent/log-correlator-query-parser");
/**
 * Main correlation engine for real-time log stream processing
 * @extends EventEmitter
 * @fires CorrelationEngine#correlationFound - When a new correlation is discovered
 * @fires CorrelationEngine#performanceMetrics - Performance metrics update
 * @fires CorrelationEngine#memoryWarning - When memory usage exceeds threshold
 * @fires CorrelationEngine#adapterAdded - When a new adapter is registered
 * @example
 * ```javascript
 * const engine = new CorrelationEngine({
 *   timeWindow: 30000,
 *   maxEvents: 10000
 * });
 * ```
 */
class CorrelationEngine extends eventemitter3_1.EventEmitter {
  constructor(options = {}) {
    super();
    this.adapters = new Map();
    this.activeJoiners = new Set();
    this.options = {
      defaultTimeWindow: options.defaultTimeWindow || "5m",
      timeWindow:
        options.timeWindow ||
        (0, utils_1.parseTimeWindow)(options.defaultTimeWindow || "5m"),
      maxEvents: options.maxEvents || 10000,
      lateTolerance:
        typeof options.lateTolerance === "string"
          ? (0, utils_1.parseTimeWindow)(options.lateTolerance)
          : options.lateTolerance || 30000,
      joinType: options.joinType || "inner",
      bufferSize: options.bufferSize || 1000,
      processingInterval:
        typeof options.processingInterval === "string"
          ? (0, utils_1.parseTimeWindow)(options.processingInterval)
          : options.processingInterval || 100,
      maxMemoryMB: options.maxMemoryMB || 100,
      gcInterval:
        typeof options.gcInterval === "string"
          ? (0, utils_1.parseTimeWindow)(options.gcInterval)
          : options.gcInterval || 30000,
    };
    // Initialize query parsers
    this.queryParser = new log_correlator_query_parser_1.PeggyQueryParser();
    // Initialize performance monitor
    this.performanceMonitor = new performance_monitor_1.PerformanceMonitor(
      5000
    );
    this.performanceMonitor.start();
    // Set up performance monitoring events
    this.performanceMonitor.on("metrics", (metrics) => {
      this.emit("performanceMetrics", metrics);
    });
    this.performanceMonitor.on("highMemoryUsage", (info) => {
      this.emit("memoryWarning", info);
    });
    // Initialize backpressure controller if needed
    if (options.bufferSize) {
      this.backpressureController =
        new backpressure_controller_1.BackpressureController({
          highWaterMark: options.bufferSize,
          lowWaterMark: Math.floor(options.bufferSize * 0.5),
          maxBufferSize: options.bufferSize * 2,
        });
    }
    // Start garbage collection
    this.startGarbageCollection();
  }
  addAdapter(name, adapter) {
    if (this.adapters.has(name)) {
      throw new types_1.CorrelationError(
        `Adapter ${name} already registered`,
        "ADAPTER_EXISTS"
      );
    }
    this.adapters.set(name, adapter);
    this.emit("adapterAdded", name);
  }
  getAdapter(name) {
    return this.adapters.get(name);
  }
  async *correlate(query) {
    // Parse the query (simplified for now - would use full parser in production)
    const parsedQuery = this.parseQuery(query);
    // Check if this is a multi-stream query (3+ streams)
    const allStreams = [parsedQuery.leftStream, parsedQuery.rightStream];
    if (
      parsedQuery.additionalStreams &&
      parsedQuery.additionalStreams.length > 0
    ) {
      allStreams.push(...parsedQuery.additionalStreams);
    }
    // Validate all adapters exist
    const adapters = [];
    const streamInfo = [];
    for (const streamQuery of allStreams) {
      const adapter = this.getAdapterForSource(streamQuery.source);
      if (!adapter) {
        throw new types_1.CorrelationError(
          "Required data source adapter not found",
          "ADAPTER_NOT_FOUND",
          {
            source: streamQuery.source,
            availableAdapters: Array.from(this.adapters.keys()),
          }
        );
      }
      adapters.push(adapter);
      // Create stream
      const stream = adapter.createStream(streamQuery.selector, {
        timeRange: streamQuery.timeRange,
      });
      // Wrap the stream to record events as they're processed
      const instrumentedStream = this.instrumentStream(stream);
      streamInfo.push({ name: streamQuery.source, stream: instrumentedStream });
    }
    // If we have more than 2 streams, use MultiStreamJoiner
    if (allStreams.length > 2) {
      const multiJoiner = new multi_stream_joiner_1.MultiStreamJoiner({
        joinType: parsedQuery.joinType,
        joinKeys: parsedQuery.joinKeys,
        timeWindow: (0, utils_1.parseTimeWindow)(
          parsedQuery.timeWindow || this.options.defaultTimeWindow
        ),
        lateTolerance: this.options.lateTolerance,
        maxEvents: this.options.maxEvents,
        temporal: parsedQuery.temporal,
        labelMappings: parsedQuery.labelMappings,
        filter: parsedQuery.filter,
      });
      this.activeJoiners.add(multiJoiner);
      try {
        // Perform multi-stream join and yield results
        for await (const correlation of multiJoiner.joinMultiple(streamInfo)) {
          this.performanceMonitor.recordCorrelation();
          this.emit("correlationFound", correlation);
          yield correlation;
        }
      } finally {
        this.activeJoiners.delete(multiJoiner);
        multiJoiner.cleanup();
      }
    } else {
      // Use regular StreamJoiner for 2-stream queries
      const joiner = new stream_joiner_1.StreamJoiner({
        joinType: parsedQuery.joinType,
        joinKeys: parsedQuery.joinKeys,
        timeWindow: (0, utils_1.parseTimeWindow)(
          parsedQuery.timeWindow || this.options.defaultTimeWindow
        ),
        lateTolerance: this.options.lateTolerance,
        maxEvents: this.options.maxEvents,
        temporal: parsedQuery.temporal
          ? (0, utils_1.parseTimeWindow)(parsedQuery.temporal)
          : undefined,
        ignoring: parsedQuery.ignoring,
        grouping: parsedQuery.grouping,
        labelMappings: parsedQuery.labelMappings,
        filter: parsedQuery.filter,
      });
      this.activeJoiners.add(joiner);
      try {
        // Perform join and yield results
        for await (const correlation of joiner.join(
          streamInfo[0].stream,
          streamInfo[1].stream
        )) {
          this.performanceMonitor.recordCorrelation();
          this.emit("correlationFound", correlation);
          yield correlation;
        }
      } finally {
        this.activeJoiners.delete(joiner);
        joiner.cleanup();
      }
    }
  }
  validateQuery(query) {
    try {
      // Normalize the query by trimming and collapsing whitespace
      const normalizedQuery = query.trim().replace(/\s+/g, " ");
      const result = this.queryParser.validate(normalizedQuery);
      if (result.valid) return true;
      return false;
    } catch {
      return false;
    }
  }
  parseQuery(query) {
    try {
      // Trim whitespace and normalize the query before parsing
      const normalizedQuery = query.trim().replace(/\s+/g, " ");
      // Parse the query using the Peggy parser
      const parsed = this.queryParser.parse(normalizedQuery);
      // Create a ParsedQuery object with all required properties
      const result = {
        leftStream: parsed.leftStream,
        rightStream: parsed.rightStream,
        joinType: parsed.joinType,
        joinKeys: parsed.joinKeys,
        timeWindow: parsed.timeWindow,
        temporal: parsed.temporal,
        grouping: parsed.grouping,
        ignoring: parsed.ignoring,
        labelMappings: parsed.labelMappings,
        filter: parsed.filter,
        additionalStreams: parsed.additionalStreams,
      };
      // Ensure timeWindow is set if not provided
      if (!result.timeWindow) {
        result.timeWindow = this.options.defaultTimeWindow;
      }
      return this.validateParsedQuery(result, normalizedQuery);
    } catch (error) {
      // Handle parse errors
      const message =
        error instanceof Error ? error.message : "Invalid query syntax";
      throw new types_1.CorrelationError(message, "QUERY_PARSE_ERROR", {
        query,
        error,
      });
    }
  }
  validateParsedQuery(result, _originalQuery) {
    // Validate that we have the required streams
    if (!result.leftStream || !result.rightStream) {
      throw new Error("Query must include at least two streams");
    }
    // Validate join type
    if (!result.joinType) {
      throw new Error("Query must specify a join type (and, or, unless)");
    }
    // Validate join keys
    if (!result.joinKeys || result.joinKeys.length === 0) {
      throw new Error("Query must specify join keys with on() clause");
    }
    return result;
  }
  async *instrumentStream(stream) {
    for await (const event of stream) {
      const startTime = new Date(event.timestamp).getTime();
      this.performanceMonitor.recordEvent(startTime);
      yield event;
    }
  }
  getAdapterForSource(source) {
    // Direct match
    if (this.adapters.has(source)) {
      return this.adapters.get(source);
    }
    // Try to find adapter by name
    for (const [name, adapter] of this.adapters) {
      if (name.toLowerCase() === source.toLowerCase()) {
        return adapter;
      }
    }
    return undefined;
  }
  startGarbageCollection() {
    this.gcInterval = setInterval(() => {
      // Clean up inactive joiners (they handle their own cleanup)
      // Check memory usage
      const memoryUsage = process.memoryUsage();
      const memoryMB = memoryUsage.heapUsed / 1024 / 1024;
      if (memoryMB > this.options.maxMemoryMB) {
        this.emit("memoryWarning", {
          usedMB: memoryMB,
          maxMB: this.options.maxMemoryMB,
        });
      }
    }, this.options.gcInterval);
  }
  async destroy() {
    // Stop performance monitor
    this.performanceMonitor.stop();
    // Clear garbage collection interval
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = undefined;
    }
    // Clean up all joiners
    for (const joiner of this.activeJoiners) {
      joiner.cleanup();
    }
    this.activeJoiners.clear();
    // Destroy all adapters
    for (const adapter of this.adapters.values()) {
      await adapter.destroy();
    }
    this.adapters.clear();
    this.removeAllListeners();
  }
}
exports.CorrelationEngine = CorrelationEngine;
//# sourceMappingURL=correlation-engine.js.map
