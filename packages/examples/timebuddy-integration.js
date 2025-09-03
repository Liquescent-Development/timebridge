/**
 * TimeBuddy Integration Example
 *
 * This example demonstrates how TimeBuddy (Time Series IDE) can integrate
 * with TimeBridge to provide unified time-series analysis across multiple
 * data sources using TimeQL.
 */

const { TimeQLExecutor } = require("@timebridge/core");
const { PrometheusAdapter } = require("@timebridge/prometheus");
const { InfluxDBAdapter } = require("@timebridge/influxdb");
const { GraylogAdapter } = require("@timebridge/graylog");
const { LokiAdapter } = require("@timebridge/loki");

/**
 * TimeBuddy Integration Class
 *
 * This class would be used by TimeBuddy to execute TimeQL queries
 * and visualize the results in the IDE.
 */
class TimeBuddyConnector {
  constructor(config = {}) {
    this.executor = new TimeQLExecutor({
      timeWindow: config.timeWindow || 300000, // 5 minutes default
      maxEvents: config.maxEvents || 100000,
      streaming: config.streaming || true,
    });

    this.visualizationMode = config.visualizationMode || "time-series";
    this.registeredSources = new Map();
  }

  /**
   * Register a data source with TimeBridge
   */
  registerDataSource(name, type, config) {
    let adapter;

    switch (type) {
      case "prometheus":
        adapter = new PrometheusAdapter(config);
        break;
      case "influxdb":
        adapter = new InfluxDBAdapter(config);
        break;
      case "graylog":
        adapter = new GraylogAdapter(config);
        break;
      case "loki":
        adapter = new LokiAdapter(config);
        break;
      default:
        throw new Error(`Unknown data source type: ${type}`);
    }

    this.executor.addAdapter(name, adapter);
    this.registeredSources.set(name, { type, config, adapter });

    console.log(`✅ Registered ${type} data source: ${name}`);
    return { success: true, source: name };
  }

  /**
   * Execute a TimeQL query and return results formatted for TimeBuddy
   */
  async executeTimeQL(query, options = {}) {
    console.log(`\n🔍 Executing TimeQL Query:\n${query}\n`);

    const results = {
      query: query,
      startTime: new Date().toISOString(),
      data: [],
      metadata: {
        sources: [],
        timeRange: null,
        correlations: 0,
        totalEvents: 0,
      },
      visualization: {
        type: options.visualizationType || this.visualizationMode,
        series: [],
      },
    };

    try {
      // Validate the query first
      const validation = this.executor.validateQuery(query);
      if (!validation.valid) {
        throw new Error(`Invalid TimeQL query: ${validation.error}`);
      }

      results.metadata.queryType = validation.type;
      results.metadata.sources = validation.sources;

      // Execute the query
      for await (const result of this.executor.execute(query)) {
        if (validation.type === "correlation") {
          // Handle correlated events
          results.data.push(this.formatCorrelation(result));
          results.metadata.correlations++;
          results.metadata.totalEvents += result.events.length;

          // Add to visualization series
          this.addCorrelationToVisualization(result, results.visualization);
        } else {
          // Handle direct query results
          results.data.push(this.formatEvent(result));
          results.metadata.totalEvents++;

          // Add to visualization series
          this.addEventToVisualization(result, results.visualization);
        }

        // Stop if we hit the limit
        if (options.limit && results.data.length >= options.limit) {
          break;
        }
      }

      results.endTime = new Date().toISOString();
      results.metadata.executionTime =
        new Date(results.endTime) - new Date(results.startTime);

      return results;
    } catch (error) {
      results.error = error.message;
      results.endTime = new Date().toISOString();
      return results;
    }
  }

  /**
   * Format a correlation for TimeBuddy display
   */
  formatCorrelation(correlation) {
    return {
      id: correlation.correlationId,
      timestamp: correlation.timestamp,
      timeWindow: {
        start: correlation.timeWindow.start,
        end: correlation.timeWindow.end,
        duration:
          new Date(correlation.timeWindow.end) -
          new Date(correlation.timeWindow.start),
      },
      correlation: {
        key: correlation.joinKey,
        value: correlation.joinValue,
      },
      events: correlation.events.map((e) => ({
        source: e.source,
        timestamp: e.timestamp,
        message: e.message,
        labels: e.labels,
      })),
      sources: [...new Set(correlation.events.map((e) => e.source))],
    };
  }

  /**
   * Format an event for TimeBuddy display
   */
  formatEvent(event) {
    return {
      timestamp: event.timestamp,
      source: event.source,
      message: event.message,
      labels: event.labels,
      joinKeys: event.joinKeys,
      value: this.extractNumericValue(event),
    };
  }

  /**
   * Extract numeric value for visualization
   */
  extractNumericValue(event) {
    // Try to extract numeric value from labels
    if (event.labels) {
      if (event.labels.__value__) {
        return parseFloat(event.labels.__value__);
      }
      if (event.labels.value) {
        return parseFloat(event.labels.value);
      }
      // Look for any numeric label
      for (const [key, value] of Object.entries(event.labels)) {
        const num = parseFloat(value);
        if (!isNaN(num)) {
          return num;
        }
      }
    }
    return null;
  }

  /**
   * Add correlation data to visualization series
   */
  addCorrelationToVisualization(correlation, visualization) {
    // Group events by source for visualization
    const sourceGroups = new Map();

    for (const event of correlation.events) {
      if (!sourceGroups.has(event.source)) {
        sourceGroups.set(event.source, []);
      }
      sourceGroups.get(event.source).push({
        x: new Date(event.timestamp).getTime(),
        y: this.extractNumericValue(event) || 0,
        correlation: correlation.joinValue,
        message: event.message,
      });
    }

    // Add series for each source
    for (const [source, points] of sourceGroups) {
      let series = visualization.series.find((s) => s.name === source);
      if (!series) {
        series = {
          name: source,
          type: "line",
          data: [],
        };
        visualization.series.push(series);
      }
      series.data.push(...points);
    }
  }

  /**
   * Add event data to visualization series
   */
  addEventToVisualization(event, visualization) {
    let series = visualization.series.find((s) => s.name === event.source);
    if (!series) {
      series = {
        name: event.source,
        type: "line",
        data: [],
      };
      visualization.series.push(series);
    }

    series.data.push({
      x: new Date(event.timestamp).getTime(),
      y: this.extractNumericValue(event) || 0,
      message: event.message,
      labels: event.labels,
    });
  }

  /**
   * Stream TimeQL results for real-time visualization in TimeBuddy
   */
  async *streamTimeQL(query, options = {}) {
    console.log(`\n📊 Streaming TimeQL Query:\n${query}\n`);

    const validation = this.executor.validateQuery(query);
    if (!validation.valid) {
      throw new Error(`Invalid TimeQL query: ${validation.error}`);
    }

    const startTime = Date.now();
    let eventCount = 0;

    for await (const result of this.executor.execute(query)) {
      eventCount++;

      // Format for streaming
      const formatted =
        validation.type === "correlation"
          ? this.formatCorrelation(result)
          : this.formatEvent(result);

      // Add streaming metadata
      formatted._stream = {
        eventNumber: eventCount,
        timestamp: new Date().toISOString(),
        elapsed: Date.now() - startTime,
      };

      yield formatted;

      // Apply streaming limit if specified
      if (options.streamLimit && eventCount >= options.streamLimit) {
        break;
      }
    }
  }

  /**
   * Get query suggestions for TimeBuddy's autocomplete
   */
  getQuerySuggestions(partialQuery) {
    const suggestions = [];

    // Suggest registered sources
    for (const [name, info] of this.registeredSources) {
      suggestions.push({
        type: "source",
        value: name,
        description: `${info.type} data source`,
        template: `${name}()[5m]`,
      });
    }

    // Suggest operators
    const operators = [
      { value: "and on", description: "Inner join", template: "and on(field)" },
      { value: "or on", description: "Left join", template: "or on(field)" },
      {
        value: "unless on",
        description: "Anti-join",
        template: "unless on(field)",
      },
      {
        value: "within",
        description: "Time window constraint",
        template: "within(30s)",
      },
      {
        value: "align on",
        description: "Timestamp alignment",
        template: "align on(timestamp)",
      },
    ];

    operators.forEach((op) => {
      suggestions.push({
        type: "operator",
        value: op.value,
        description: op.description,
        template: op.template,
      });
    });

    // Suggest time ranges
    const timeRanges = [
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "3h",
      "6h",
      "12h",
      "1d",
      "7d",
    ];
    timeRanges.forEach((range) => {
      suggestions.push({
        type: "timeRange",
        value: range,
        description: `Time range: ${range}`,
        template: `[${range}]`,
      });
    });

    return suggestions;
  }

  /**
   * Validate TimeQL query for TimeBuddy's editor
   */
  validateTimeQL(query) {
    try {
      const validation = this.executor.validateQuery(query);
      return {
        valid: validation.valid,
        type: validation.type,
        sources: validation.sources,
        error: validation.error,
        suggestions: validation.error ? this.getQuerySuggestions(query) : [],
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        suggestions: this.getQuerySuggestions(query),
      };
    }
  }

  /**
   * Get data source schema for TimeBuddy's explorer
   */
  async getDataSourceSchema(sourceName) {
    const source = this.registeredSources.get(sourceName);
    if (!source) {
      throw new Error(`Unknown data source: ${sourceName}`);
    }

    const schema = {
      name: sourceName,
      type: source.type,
      fields: [],
      metrics: [],
      indexes: [],
    };

    // Get schema based on source type
    switch (source.type) {
      case "prometheus":
        // Get available metrics
        schema.metrics = await this.getPrometheusMetrics(source.adapter);
        break;
      case "influxdb":
        // Get measurements and fields
        schema.measurements = await this.getInfluxDBMeasurements(
          source.adapter
        );
        break;
      case "graylog":
        // Get available fields
        schema.fields = await this.getGraylogFields(source.adapter);
        break;
      case "loki":
        // Get labels
        schema.labels = await this.getLokiLabels(source.adapter);
        break;
    }

    return schema;
  }

  // Helper methods for schema discovery (would be implemented based on actual APIs)
  async getPrometheusMetrics(adapter) {
    // This would query Prometheus for available metrics
    return [
      "cpu_usage",
      "memory_usage",
      "http_requests_total",
      "http_duration_seconds",
    ];
  }

  async getInfluxDBMeasurements(adapter) {
    // This would query InfluxDB for measurements
    return ["cpu", "memory", "disk", "network", "application_metrics"];
  }

  async getGraylogFields(adapter) {
    // This would query Graylog for available fields
    return ["timestamp", "message", "level", "service", "host", "request_id"];
  }

  async getLokiLabels(adapter) {
    // This would query Loki for available labels
    return ["job", "instance", "namespace", "pod", "container"];
  }
}

/**
 * Example usage showing how TimeBuddy would use TimeBridge
 */
async function demonstrateTimeBuddyIntegration() {
  console.log("🚀 TimeBuddy Integration Demo\n");
  console.log("=".repeat(60));

  // Initialize TimeBuddy connector
  const connector = new TimeBuddyConnector({
    timeWindow: 60000,
    visualizationMode: "time-series",
  });

  // Register data sources (would be done through TimeBuddy UI)
  connector.registerDataSource("prometheus-prod", "prometheus", {
    url: "http://prometheus:9090",
  });

  connector.registerDataSource("influxdb-metrics", "influxdb", {
    url: "http://influxdb:8086",
    database: "metrics",
    version: "1.x",
  });

  connector.registerDataSource("graylog-logs", "graylog", {
    url: "http://graylog:9000",
    apiToken: "token",
  });

  // Example 1: Execute a simple TimeQL query
  console.log("\n📝 Example 1: Simple Time-Series Query");
  const simpleQuery = 'prometheus-prod(up{job="api"})[5m]';
  const simpleResults = await connector.executeTimeQL(simpleQuery, {
    limit: 10,
  });

  console.log(`Query returned ${simpleResults.data.length} events`);
  console.log(`Execution time: ${simpleResults.metadata.executionTime}ms`);
  console.log(
    `Visualization series: ${simpleResults.visualization.series.length}`
  );

  // Example 2: Complex correlation query
  console.log("\n📝 Example 2: Cross-Source Correlation");
  const correlationQuery = `
    prometheus-prod(rate(http_requests_total{status="500"}[1m]))[10m]
      and on(service)
    influxdb-metrics(SELECT * FROM errors GROUP BY service)[10m]
      and on(service)
    graylog-logs(level:error)[10m]
  `;

  const correlationResults = await connector.executeTimeQL(correlationQuery, {
    limit: 5,
  });
  console.log(`Found ${correlationResults.metadata.correlations} correlations`);
  console.log(
    `Total events correlated: ${correlationResults.metadata.totalEvents}`
  );

  // Example 3: Real-time streaming
  console.log("\n📝 Example 3: Real-time Streaming");
  const streamQuery = "prometheus-prod(up)[1m]";

  let streamCount = 0;
  for await (const event of connector.streamTimeQL(streamQuery, {
    streamLimit: 5,
  })) {
    streamCount++;
    console.log(
      `  Stream event ${event._stream.eventNumber}: ${event.source} at ${event.timestamp}`
    );
  }

  // Example 4: Query validation
  console.log("\n📝 Example 4: Query Validation");
  const testQueries = [
    "prometheus-prod(up)[5m]",
    "invalid query syntax",
    "prometheus-prod(up)[5m] and on(job) graylog-logs(service:api)[5m]",
  ];

  for (const testQuery of testQueries) {
    const validation = connector.validateTimeQL(testQuery);
    console.log(
      `  "${testQuery.substring(0, 40)}...": ${
        validation.valid ? "✅ Valid" : "❌ Invalid"
      }`
    );
    if (!validation.valid) {
      console.log(`    Error: ${validation.error}`);
    }
  }

  // Example 5: Schema discovery
  console.log("\n📝 Example 5: Schema Discovery");
  const schema = await connector.getDataSourceSchema("prometheus-prod");
  console.log(`  Source: ${schema.name} (${schema.type})`);
  console.log(`  Available metrics: ${schema.metrics.join(", ")}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("✨ TimeBuddy Integration Complete!");
  console.log("\nKey Features Demonstrated:");
  console.log("  ✓ TimeQL query execution");
  console.log("  ✓ Cross-source correlation");
  console.log("  ✓ Real-time streaming");
  console.log("  ✓ Query validation");
  console.log("  ✓ Schema discovery");
  console.log("\nTimeBuddy can now use TimeBridge to provide unified");
  console.log("time-series analysis across all observability platforms!");
}

// Export for use by TimeBuddy
module.exports = { TimeBuddyConnector };

// Run demo if executed directly
if (require.main === module) {
  demonstrateTimeBuddyIntegration().catch(console.error);
}
