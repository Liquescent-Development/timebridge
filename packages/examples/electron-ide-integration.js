// Electron IDE Integration Example
// Shows how to integrate the log correlator into an Electron-based IDE
// for real-time log analysis and visualization

const { TimeBridgeEngine } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");
const { GraylogAdapter } = require("@timebridge/graylog");
const { PromQLAdapter } = require("@timebridge/promql");
const { EventEmitter } = require("events");

class IDETimeBridgeEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    // Initialize the correlation engine
    this.engine = new TimeBridgeEngine({
      defaultTimeWindow: config.defaultTimeWindow || "5m",
      maxEvents: config.maxEvents || 10000,
      lateTolerance: config.lateTolerance || "30s",
      bufferSize: config.bufferSize || 1000,
      maxMemoryMB: config.maxMemoryMB || 100,
    });

    // Track active queries for cancellation
    this.activeQueries = new Map();

    // Track query history for IDE features
    this.queryHistory = [];
    this.maxHistorySize = 100;

    // Performance metrics for IDE display
    this.metrics = {
      totalQueries: 0,
      activeQueries: 0,
      totalCorrelations: 0,
      averageQueryTime: 0,
    };

    // Set up data source adapters based on config
    this.setupAdapters(config);

    // Listen to engine events
    this.setupEventListeners();
  }

  setupAdapters(config) {
    // Loki adapter for log aggregation
    if (config.lokiUrl) {
      this.engine.addAdapter(
        "loki",
        new LokiAdapter({
          url: config.lokiUrl,
          websocket: config.enableWebSocket !== false,
          authToken: config.lokiToken,
          timeout: config.timeout || 30000,
        })
      );
    }

    // Graylog adapter
    if (config.graylogUrl) {
      this.engine.addAdapter(
        "graylog",
        new GraylogAdapter({
          url: config.graylogUrl,
          username: config.graylogUser,
          password: config.graylogPassword,
          pollInterval: config.pollInterval || 2000,
        })
      );
    }

    // Prometheus adapter for metrics correlation
    if (config.prometheusUrl) {
      this.engine.addAdapter(
        "promql",
        new PromQLAdapter({
          url: config.prometheusUrl,
          authToken: config.prometheusToken,
        })
      );
    }
  }

  setupEventListeners() {
    // Forward engine events to IDE
    this.engine.on("correlationFound", (correlation) => {
      this.metrics.totalCorrelations++;
      this.emit("correlationFound", this.formatForIDE(correlation));
    });

    this.engine.on("performanceMetrics", (metrics) => {
      this.emit("performanceUpdate", metrics);
    });

    this.engine.on("memoryWarning", (warning) => {
      this.emit("warning", {
        type: "memory",
        message: `High memory usage: ${warning.usedMB}MB`,
        severity: "warning",
      });
    });
  }

  // Execute a correlation query with IDE-specific features
  async executeQuery(queryText, options = {}) {
    const queryId = this.generateQueryId();
    const startTime = Date.now();

    // Add to query history
    this.addToHistory({
      id: queryId,
      query: queryText,
      timestamp: new Date().toISOString(),
      status: "running",
    });

    // Track as active query
    this.activeQueries.set(queryId, {
      query: queryText,
      startTime,
      abortController: new AbortController(),
    });

    this.metrics.activeQueries++;
    this.metrics.totalQueries++;

    try {
      const results = [];
      const maxResults = options.maxResults || 1000;

      // Stream results with progress updates
      let count = 0;
      for await (const correlation of this.engine.correlate(queryText)) {
        results.push(this.formatForIDE(correlation));
        count++;

        // Emit progress updates for IDE progress bar
        if (count % 10 === 0) {
          this.emit("queryProgress", {
            queryId,
            correlationsFound: count,
            elapsedTime: Date.now() - startTime,
          });
        }

        // Respect result limit
        if (count >= maxResults) {
          this.emit("info", {
            queryId,
            message: `Result limit (${maxResults}) reached`,
          });
          break;
        }

        // Check for cancellation
        if (!this.activeQueries.has(queryId)) {
          break;
        }
      }

      // Update metrics
      const queryTime = Date.now() - startTime;
      this.updateAverageQueryTime(queryTime);

      // Update history with results
      this.updateHistory(queryId, {
        status: "completed",
        resultCount: results.length,
        executionTime: queryTime,
      });

      // Emit completion event
      this.emit("queryComplete", {
        queryId,
        results,
        executionTime: queryTime,
        timestamp: new Date().toISOString(),
      });

      return {
        queryId,
        results,
        executionTime: queryTime,
        resultCount: results.length,
      };
    } catch (error) {
      // Update history with error
      this.updateHistory(queryId, {
        status: "error",
        error: error.message,
      });

      // Emit error event for IDE error display
      this.emit("queryError", {
        queryId,
        error: error.message,
        query: queryText,
      });

      throw error;
    } finally {
      // Clean up active query
      this.activeQueries.delete(queryId);
      this.metrics.activeQueries--;
    }
  }

  // Cancel a running query
  cancelQuery(queryId) {
    const activeQuery = this.activeQueries.get(queryId);
    if (activeQuery) {
      activeQuery.abortController.abort();
      this.activeQueries.delete(queryId);
      this.metrics.activeQueries--;

      this.updateHistory(queryId, {
        status: "cancelled",
      });

      this.emit("queryCancelled", { queryId });
      return true;
    }
    return false;
  }

  // Format correlation for IDE display
  formatForIDE(correlation) {
    return {
      id: correlation.correlationId,
      timestamp: correlation.timestamp,
      joinKey: correlation.joinKey,
      joinValue: correlation.joinValue,
      events: correlation.events.map((event) => ({
        source: event.source,
        timestamp: event.timestamp,
        message: event.message,
        labels: event.labels,
        severity: this.detectSeverity(event),
      })),
      timeline: this.generateTimeline(correlation.events),
      summary: this.generateSummary(correlation),
    };
  }

  // Generate a visual timeline for IDE display
  generateTimeline(events) {
    if (events.length === 0) return null;

    const sortedEvents = [...events].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    const start = new Date(sortedEvents[0].timestamp).getTime();
    const end = new Date(
      sortedEvents[sortedEvents.length - 1].timestamp
    ).getTime();
    const duration = end - start;

    return {
      startTime: sortedEvents[0].timestamp,
      endTime: sortedEvents[sortedEvents.length - 1].timestamp,
      duration,
      events: sortedEvents.map((event) => ({
        timestamp: event.timestamp,
        offset: new Date(event.timestamp).getTime() - start,
        percentage:
          duration > 0
            ? ((new Date(event.timestamp).getTime() - start) / duration) * 100
            : 0,
        source: event.source,
        severity: this.detectSeverity(event),
      })),
    };
  }

  // Generate a summary for quick understanding
  generateSummary(correlation) {
    const errorCount = correlation.events.filter(
      (e) => this.detectSeverity(e) === "error"
    ).length;

    const sources = [...new Set(correlation.events.map((e) => e.source))];

    return {
      eventCount: correlation.events.length,
      errorCount,
      sources: sources.join(", "),
      duration: this.calculateDuration(correlation.events),
      hasErrors: errorCount > 0,
    };
  }

  // Detect event severity for color coding in IDE
  detectSeverity(event) {
    const message = event.message.toLowerCase();
    const level = event.labels.level?.toLowerCase();

    if (level === "error" || level === "fatal" || message.includes("error")) {
      return "error";
    }
    if (
      level === "warning" ||
      level === "warn" ||
      message.includes("warning")
    ) {
      return "warning";
    }
    if (level === "debug" || message.includes("debug")) {
      return "debug";
    }
    return "info";
  }

  // Calculate duration between first and last event
  calculateDuration(events) {
    if (events.length < 2) return 0;

    const times = events.map((e) => new Date(e.timestamp).getTime());
    return Math.max(...times) - Math.min(...times);
  }

  // Query validation for IDE autocomplete and syntax checking
  async validateQuery(queryText) {
    try {
      const isValid = this.engine.validateQuery(queryText);
      return {
        valid: isValid,
        error: isValid ? null : "Invalid query syntax",
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  // Get available data sources for IDE dropdown
  async getAvailableStreams(source) {
    const adapter = this.engine.getAdapter(source);
    if (!adapter) {
      return [];
    }

    try {
      const streams = await adapter.getAvailableStreams();
      return streams.map((stream) => ({
        name: stream,
        source,
        type: this.detectStreamType(stream),
      }));
    } catch (error) {
      this.emit("warning", {
        message: `Failed to fetch streams from ${source}: ${error.message}`,
      });
      return [];
    }
  }

  // Detect stream type for IDE icons
  detectStreamType(streamName) {
    if (streamName.includes("error") || streamName.includes("exception")) {
      return "error";
    }
    if (streamName.includes("metric") || streamName.includes("gauge")) {
      return "metric";
    }
    if (streamName.includes("trace")) {
      return "trace";
    }
    return "log";
  }

  // Get query suggestions for IDE autocomplete
  getQuerySuggestions(partialQuery) {
    const suggestions = [];

    // Source suggestions
    if (!partialQuery || partialQuery.length < 3) {
      suggestions.push(
        { type: "source", value: "loki(", description: "Query Loki logs" },
        {
          type: "source",
          value: "graylog(",
          description: "Query Graylog logs",
        },
        {
          type: "source",
          value: "promql(",
          description: "Query Prometheus metrics",
        }
      );
    }

    // Join operator suggestions
    if (partialQuery.includes(")[")) {
      suggestions.push(
        { type: "operator", value: "and on(", description: "Inner join" },
        { type: "operator", value: "or on(", description: "Left join" },
        { type: "operator", value: "unless on(", description: "Anti-join" }
      );
    }

    // Modifier suggestions
    if (partialQuery.includes("on(") && partialQuery.includes(")")) {
      suggestions.push(
        {
          type: "modifier",
          value: "within(30s)",
          description: "Temporal constraint",
        },
        {
          type: "modifier",
          value: "group_left(",
          description: "Many-to-one join",
        },
        {
          type: "modifier",
          value: "group_right(",
          description: "One-to-many join",
        },
        { type: "modifier", value: "ignoring(", description: "Ignore labels" }
      );
    }

    return suggestions;
  }

  // Query history management
  addToHistory(entry) {
    this.queryHistory.unshift(entry);
    if (this.queryHistory.length > this.maxHistorySize) {
      this.queryHistory.pop();
    }
  }

  updateHistory(queryId, updates) {
    const entry = this.queryHistory.find((h) => h.id === queryId);
    if (entry) {
      Object.assign(entry, updates);
    }
  }

  getHistory(limit = 10) {
    return this.queryHistory.slice(0, limit);
  }

  // Performance metrics
  updateAverageQueryTime(queryTime) {
    const total =
      this.metrics.averageQueryTime * (this.metrics.totalQueries - 1);
    this.metrics.averageQueryTime =
      (total + queryTime) / this.metrics.totalQueries;
  }

  getMetrics() {
    return {
      ...this.metrics,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
    };
  }

  // Generate unique query ID
  generateQueryId() {
    return `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Clean up resources
  async destroy() {
    // Cancel all active queries
    for (const [queryId] of this.activeQueries) {
      this.cancelQuery(queryId);
    }

    // Destroy engine
    await this.engine.destroy();

    // Clear data
    this.queryHistory = [];
    this.activeQueries.clear();
  }
}

// Example usage in an Electron renderer process
async function setupIDEIntegration() {
  // Initialize the IDE correlation engine
  const correlationEngine = new IDETimeBridgeEngine({
    lokiUrl: "http://localhost:3100",
    graylogUrl: "http://localhost:9000",
    prometheusUrl: "http://localhost:9090",
    defaultTimeWindow: "5m",
    maxEvents: 10000,
    enableWebSocket: true,
  });

  // Set up IDE event handlers
  correlationEngine.on("correlationFound", (correlation) => {
    // Update IDE visualization
    updateTimelineView(correlation.timeline);
    updateEventList(correlation.events);
  });

  correlationEngine.on("queryProgress", (progress) => {
    // Update progress bar
    updateProgressBar(progress.correlationsFound);
  });

  correlationEngine.on("queryComplete", (result) => {
    // Show results in IDE
    displayResults(result);
  });

  correlationEngine.on("warning", (warning) => {
    // Show warning notification
    showNotification(warning);
  });

  // Example query execution
  const result = await correlationEngine.executeQuery(`
    loki({service="frontend"})[5m]
      and on(request_id)
      loki({service="backend"})[5m]
  `);

  console.log(
    `Found ${result.resultCount} correlations in ${result.executionTime}ms`
  );

  // Get query suggestions for autocomplete
  const suggestions = correlationEngine.getQuerySuggestions("loki(");
  console.log("Suggestions:", suggestions);

  // Validate a query
  const validation = await correlationEngine.validateQuery("invalid query");
  console.log("Validation:", validation);

  return correlationEngine;
}

// Placeholder functions for IDE UI updates
function updateTimelineView(timeline) {
  console.log("Timeline:", timeline);
}

function updateEventList(events) {
  console.log("Events:", events);
}

function updateProgressBar(count) {
  console.log("Progress:", count);
}

function displayResults(result) {
  console.log("Results:", result);
}

function showNotification(notification) {
  console.log("Notification:", notification);
}

module.exports = { IDETimeBridgeEngine, setupIDEIntegration };
