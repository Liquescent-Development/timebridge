import {
  GrafanaDataSourceProxy,
  GrafanaProxyConfig,
  GrafanaQueryRequest,
  GrafanaQueryResponse,
} from "@timebridge/core/src/grafana/grafana-datasource-proxy";
import { LogEvent } from "@timebridge/core";

/**
 * Loki-specific Grafana proxy implementation
 */
export class LokiGrafanaProxy extends GrafanaDataSourceProxy {
  constructor(config: GrafanaProxyConfig) {
    super(config);
  }

  getDataSourceType(): string {
    return "loki";
  }

  /**
   * Transform LogQL query to Grafana format
   */
  transformQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ): GrafanaQueryRequest {
    // Determine query type based on query content and options
    const isMetricQuery = this.isMetricQuery(query);
    const isInstant = options?.instant === true || isMetricQuery;

    // Build the query object
    const queryObj = {
      datasource: { uid: datasourceUid },
      expr: query, // LogQL expression
      refId: "A",
      queryType: isInstant ? "instant" : "range",
      maxLines: options?.maxLines || 1000,
      legendFormat: "", // Auto format
      step: options?.step,
      resolution: 1,
      direction: "backward", // Latest logs first
    };

    // Apply additional options but don't let them override queryType
    if (options) {
      const { instant, ...otherOptions } = options;
      Object.assign(queryObj, otherOptions);
    }

    return {
      queries: [queryObj],
      from: timeRange.from,
      to: timeRange.to,
    };
  }

  /**
   * Check if a query is a metric query (vs log query)
   */
  private isMetricQuery(query: string): boolean {
    // Metric queries contain aggregation functions
    const metricFunctions = [
      "rate(",
      "count_over_time(",
      "sum_over_time(",
      "avg_over_time(",
      "max_over_time(",
      "min_over_time(",
      "stddev_over_time(",
      "quantile_over_time(",
      "bytes_rate(",
      "bytes_over_time(",
      "absent_over_time(",
    ];

    const lowerQuery = query.toLowerCase();
    return metricFunctions.some(func => lowerQuery.includes(func));
  }

  /**
   * Parse Grafana Loki response to LogEvent stream
   */
  async *parseResponse(response: GrafanaQueryResponse): AsyncIterable<LogEvent> {
    for (const [refId, result] of Object.entries(response.results)) {
      if (result.frames) {
        // Modern Grafana response format (data frames)
        for (const frame of result.frames) {
          yield* this.parseDataFrame(frame);
        }
      } else if (result.series) {
        // Legacy response format - metrics
        yield* this.parseMetricSeries(result.series);
      } else if ((result as any).streams) {
        // Log streams format
        yield* this.parseLogStreams((result as any).streams);
      } else if ((result as any).tables) {
        // Table format
        yield* this.parseTables((result as any).tables);
      }
    }
  }

  /**
   * Parse a Grafana data frame (logs or metrics)
   */
  private async *parseDataFrame(frame: any): AsyncIterable<LogEvent> {
    // Detect frame type based on fields
    const hasTimeField = frame.schema.fields.some((f: any) => f.type === "time");
    const hasStringField = frame.schema.fields.some((f: any) => f.type === "string");
    
    if (hasTimeField && hasStringField) {
      // Log frame
      yield* this.parseLogFrame(frame);
    } else if (hasTimeField) {
      // Metric frame
      yield* this.parseMetricFrame(frame);
    }
  }

  /**
   * Parse log data frame
   */
  private async *parseLogFrame(frame: any): AsyncIterable<LogEvent> {
    // Find field indices
    let timeFieldIndex = -1;
    let lineFieldIndex = -1;
    let levelFieldIndex = -1;
    const labelFields: Map<number, string> = new Map();

    frame.schema.fields.forEach((field: any, index: number) => {
      if (field.type === "time") {
        timeFieldIndex = index;
      } else if (field.name === "line" || field.name === "Line" || field.name === "message") {
        lineFieldIndex = index;
      } else if (field.name === "level" || field.name === "severity") {
        levelFieldIndex = index;
      } else if (field.name === "labels" && field.type === "json") {
        // JSON labels field
        labelFields.set(index, "labels");
      } else if (field.type === "string" && field.name !== "line") {
        // These are labels
        labelFields.set(index, field.name);
      }
    });

    if (timeFieldIndex === -1 || lineFieldIndex === -1) {
      return; // Invalid log frame
    }

    // Extract labels from frame metadata
    const frameLabels = frame.schema.meta?.labels || {};

    // Yield events for each log line
    const timeValues = frame.data.values[timeFieldIndex];
    const lineValues = frame.data.values[lineFieldIndex];
    const levelValues = levelFieldIndex >= 0 ? frame.data.values[levelFieldIndex] : null;

    for (let i = 0; i < timeValues.length; i++) {
      const timestamp = new Date(timeValues[i]).toISOString();
      const logLine = lineValues[i];

      // Skip entries without log content
      if (logLine === null || logLine === undefined || logLine === "") {
        continue;
      }

      // Build labels for this log entry
      const labels: Record<string, string> = { ...frameLabels };
      
      // Add level if available
      if (levelValues && levelValues[i]) {
        labels["level"] = levelValues[i];
      }

      // Add other label fields
      labelFields.forEach((fieldName, fieldIndex) => {
        const value = frame.data.values[fieldIndex]?.[i];
        if (value !== null && value !== undefined) {
          if (fieldName === "labels" && typeof value === "object") {
            // JSON labels - merge them in
            Object.assign(labels, value);
          } else {
            labels[fieldName] = String(value);
          }
        }
      });

      // Extract structured data from log line if JSON
      const joinKeys = this.extractJoinKeysFromLog(logLine, labels);

      yield {
        timestamp,
        source: "loki",
        stream: labels.job || labels.service || "unknown",
        message: logLine,
        labels,
        joinKeys,
      };
    }
  }

  /**
   * Parse metric data frame
   */
  private async *parseMetricFrame(frame: any): AsyncIterable<LogEvent> {
    // Similar to Prometheus parsing but for Loki metrics
    let timeFieldIndex = -1;
    let valueFieldIndex = -1;
    let valueFieldLabels: Record<string, string> = {};
    let metricName = "value";

    frame.schema.fields.forEach((field: any, index: number) => {
      if (field.type === "time") {
        timeFieldIndex = index;
      } else if (field.type === "number") {
        valueFieldIndex = index;
        // Labels can be on the field itself
        if (field.labels) {
          valueFieldLabels = field.labels;
        }
        // Metric name is either __name__ label or field name
        metricName = field.labels?.__name__ || field.name || "value";
      }
    });

    if (timeFieldIndex === -1 || valueFieldIndex === -1) {
      return;
    }

    // Combine labels from frame metadata and field labels
    const labels = {
      ...frame.schema.meta?.labels || {},
      ...valueFieldLabels,
    };

    const timeValues = frame.data.values[timeFieldIndex];
    const dataValues = frame.data.values[valueFieldIndex];

    for (let i = 0; i < timeValues.length; i++) {
      const timestamp = new Date(timeValues[i]).toISOString();
      const value = dataValues[i];

      if (value === null || value === undefined) {
        continue;
      }

      yield {
        timestamp,
        source: "loki",
        stream: labels.job || labels.service || "metric",
        message: `${metricName}${this.formatLabels(labels)} ${value}`,
        labels: {
          ...labels,
          "__value__": String(value),
          "__name__": metricName,
        },
        joinKeys: this.extractJoinKeys(labels),
      };
    }
  }

  /**
   * Parse log streams format (legacy)
   */
  private async *parseLogStreams(streams: any[]): AsyncIterable<LogEvent> {
    for (const stream of streams) {
      const labels = stream.stream || stream.labels || {};
      
      for (const entry of stream.values || stream.entries || []) {
        // Entry format: [timestamp_ns, log_line] or {ts: timestamp, line: log_line}
        const [ts, line] = Array.isArray(entry) 
          ? entry 
          : [entry.ts, entry.line];

        // Convert nanosecond timestamp to ISO string
        const timestampMs = typeof ts === "string" 
          ? parseInt(ts) / 1000000 
          : ts / 1000000;
        const timestamp = new Date(timestampMs).toISOString();

        const joinKeys = this.extractJoinKeysFromLog(line, labels);

        yield {
          timestamp,
          source: "loki",
          stream: labels.job || labels.service || "unknown",
          message: line,
          labels,
          joinKeys,
        };
      }
    }
  }

  /**
   * Parse metric series format (legacy)
   */
  private async *parseMetricSeries(series: any[]): AsyncIterable<LogEvent> {
    for (const serie of series) {
      const labels = serie.tags || serie.labels || {};
      const metricName = serie.name || serie.target || "value";

      for (const point of serie.points || serie.datapoints || []) {
        const [val, ts] = Array.isArray(point) ? point : [point.value, point.timestamp];
        
        if (val === null || val === undefined) {
          continue;
        }

        const timestamp = new Date(ts).toISOString();
        
        // Check if this is actually a log series (string value) vs metric
        if (typeof val === "string" && isNaN(parseFloat(val))) {
          // This is a log entry
          yield {
            timestamp,
            source: "loki",
            stream: labels.job || labels.service || "logs",
            message: val,
            labels,
            joinKeys: this.extractJoinKeys(labels),
          };
        } else {
          // This is a metric value
          const value = typeof val === "number" ? val : parseFloat(val);
          
          yield {
            timestamp,
            source: "loki",
            stream: labels.job || labels.service || "metric",
            message: `${metricName}${this.formatLabels(labels)} ${value}`,
            labels: {
              ...labels,
              "__value__": String(value),
              "__name__": metricName,
            },
            joinKeys: this.extractJoinKeys(labels),
          };
        }
      }
    }
  }

  /**
   * Parse table format response
   */
  private async *parseTables(tables: any[]): AsyncIterable<LogEvent> {
    for (const table of tables) {
      const columns = table.columns || [];
      const rows = table.rows || [];

      // Find time and message columns
      const timeCol = columns.find((c: any) => 
        c.text === "Time" || c.text === "time" || c.text === "ts" || c.type === "time"
      );
      const messageCol = columns.find((c: any) =>
        c.text === "Line" || c.text === "line" || c.text === "message" || c.text === "Message"
      );

      if (!timeCol || !messageCol) continue;

      const timeIndex = columns.indexOf(timeCol);
      const messageIndex = columns.indexOf(messageCol);

      for (const row of rows) {
        const timestamp = new Date(row[timeIndex]).toISOString();
        const message = row[messageIndex];

        // Build labels from other columns
        const labels: Record<string, string> = {};
        columns.forEach((col: any, index: number) => {
          if (index !== timeIndex && index !== messageIndex) {
            const value = row[index];
            if (value !== null && value !== undefined) {
              labels[col.text] = String(value);
            }
          }
        });

        yield {
          timestamp,
          source: "loki",
          stream: labels.job || labels.service || "logs",
          message,
          labels,
          joinKeys: this.extractJoinKeys(labels),
        };
      }
    }
  }

  /**
   * Format labels for display
   */
  private formatLabels(labels: Record<string, string>): string {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(labels)) {
      // Skip internal labels (starting with __)
      if (key.startsWith("__")) continue;
      pairs.push(`${key}="${value}"`);
    }
    return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
  }

  /**
   * Extract join keys from labels
   */
  private extractJoinKeys(labels: Record<string, string>): Record<string, string> {
    const joinKeys: Record<string, string> = {};
    
    // Common correlation keys in logs
    const correlationKeys = [
      "job",
      "instance",
      "pod",
      "namespace",
      "service",
      "deployment",
      "node",
      "container",
      "host",
      "trace_id",
      "span_id",
      "request_id",
      "transaction_id",
      "correlation_id",
      "session_id",
      "user_id",
      "level",
    ];

    for (const key of correlationKeys) {
      if (labels[key]) {
        joinKeys[key] = labels[key];
      }
    }

    return joinKeys;
  }

  /**
   * Extract join keys from log message
   */
  private extractJoinKeysFromLog(
    logLine: string, 
    labels: Record<string, string>
  ): Record<string, string> {
    const keys: Record<string, string> = {};

    // Start with label-based keys
    Object.assign(keys, this.extractJoinKeys(labels));

    // Try to parse JSON logs
    try {
      if (logLine.trim().startsWith("{")) {
        const parsed = JSON.parse(logLine);
        
        // Look for correlation IDs in JSON
        const correlationFields = [
          "trace_id", "traceId", "trace-id",
          "span_id", "spanId", "span-id",
          "request_id", "requestId", "request-id",
          "correlation_id", "correlationId", "correlation-id",
          "session_id", "sessionId", "session-id",
          "transaction_id", "transactionId", "transaction-id",
        ];

        for (const field of correlationFields) {
          if (parsed[field]) {
            const normalizedKey = field.toLowerCase().replace(/-/g, "_");
            keys[normalizedKey] = String(parsed[field]);
          }
        }
      }
    } catch {
      // Not JSON, try regex patterns
      const patterns = [
        /(?:trace[_-]?id|traceId)[=:\s]+["']?([a-zA-Z0-9-]+)/i,
        /(?:span[_-]?id|spanId)[=:\s]+["']?([a-zA-Z0-9-]+)/i,
        /(?:request[_-]?id|requestId)[=:\s]+["']?([a-zA-Z0-9-]+)/i,
        /(?:correlation[_-]?id|correlationId)[=:\s]+["']?([a-zA-Z0-9-]+)/i,
        /(?:session[_-]?id|sessionId)[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      ];

      for (const pattern of patterns) {
        const match = logLine?.match(pattern);
        if (match) {
          const keyName = pattern.source
            .split("(?:")[1]
            .split("|")[0]
            .replace(/[^a-z]/g, "_");
          keys[keyName] = match[1];
        }
      }
    }

    return keys;
  }

  /**
   * Get available labels
   */
  async getLabels(): Promise<string[]> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    
    const response = await this.makeRequest(
      `/api/datasources/uid/${dataSource.uid}/resources/loki/api/v1/labels`,
      { method: "GET" }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch labels: ${response.statusText}`);
    }

    const data = await response.json();
    // Handle different response formats
    if (Array.isArray(data)) {
      return data;
    }
    // Check for Loki API response format { data: [...] } or { values: [...] }
    if (data.data && Array.isArray(data.data)) {
      return data.data;
    }
    if (data.values && Array.isArray(data.values)) {
      return data.values;
    }
    return [];
  }

  /**
   * Get label values
   */
  async getLabelValues(label: string): Promise<string[]> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    
    const response = await this.makeRequest(
      `/api/datasources/uid/${dataSource.uid}/resources/loki/api/v1/label/${label}/values`,
      { method: "GET" }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch label values: ${response.statusText}`);
    }

    const data = await response.json();
    // Handle different response formats
    if (Array.isArray(data)) {
      return data;
    }
    // Check for Loki API response format { data: [...] } or { values: [...] }
    if (data.data && Array.isArray(data.data)) {
      return data.data;
    }
    if (data.values && Array.isArray(data.values)) {
      return data.values;
    }
    return [];
  }
}