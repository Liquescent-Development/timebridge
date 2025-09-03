import {
  GrafanaDataSourceProxy,
  GrafanaProxyConfig,
  GrafanaQueryRequest,
  GrafanaQueryResponse,
} from "@timebridge/core/src/grafana/grafana-datasource-proxy";
import { LogEvent } from "@timebridge/core";

/**
 * Prometheus-specific Grafana proxy implementation
 */
export class PrometheusGrafanaProxy extends GrafanaDataSourceProxy {
  constructor(config: GrafanaProxyConfig) {
    super(config);
  }

  getDataSourceType(): string {
    return "prometheus";
  }

  /**
   * Transform PromQL query to Grafana format
   */
  transformQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ): GrafanaQueryRequest {
    // Calculate step interval based on time range
    const fromMs = parseInt(timeRange.from);
    const toMs = parseInt(timeRange.to);
    const rangeMs = toMs - fromMs;
    
    // Auto-calculate step (aim for ~1000 data points max)
    const stepSeconds = Math.max(15, Math.floor(rangeMs / 1000 / 1000));

    return {
      queries: [
        {
          datasource: { uid: datasourceUid },
          expr: query, // PromQL expression
          refId: "A",
          format: "time_series",
          instant: false,
          range: true,
          interval: `${stepSeconds}s`,
          intervalMs: stepSeconds * 1000,
          maxDataPoints: 1000,
          step: stepSeconds,
          ...options, // Allow override of any options
        },
      ],
      from: timeRange.from,
      to: timeRange.to,
    };
  }

  /**
   * Parse Grafana Prometheus response to LogEvent stream
   */
  async *parseResponse(response: GrafanaQueryResponse): AsyncIterable<LogEvent> {
    for (const [refId, result] of Object.entries(response.results)) {
      if (result.frames) {
        // Modern Grafana response format (data frames)
        for (const frame of result.frames) {
          yield* this.parseDataFrame(frame);
        }
      } else if (result.series) {
        // Legacy response format
        yield* this.parseLegacySeries(result.series);
      }
    }
  }

  /**
   * Parse a Grafana data frame
   */
  private async *parseDataFrame(frame: any): AsyncIterable<LogEvent> {
    // Find time and value fields
    let timeFieldIndex = -1;
    let valueFieldIndex = -1;
    const labelFields: Map<number, string> = new Map();

    frame.schema.fields.forEach((field: any, index: number) => {
      if (field.type === "time") {
        timeFieldIndex = index;
      } else if (field.type === "number") {
        valueFieldIndex = index;
      } else if (field.type === "string") {
        // These are likely labels
        labelFields.set(index, field.name);
      }
    });

    if (timeFieldIndex === -1 || valueFieldIndex === -1) {
      return; // Invalid frame structure
    }

    // Extract metric name and labels from field configuration
    const valueField = frame.schema.fields[valueFieldIndex];
    const labels: Record<string, string> = {};
    
    // Parse labels from field name or config
    if (valueField.labels) {
      Object.assign(labels, valueField.labels);
    }

    // Parse display name for metric info
    const metricName = valueField.name || "value";
    
    // Yield events for each data point
    const timeValues = frame.data.values[timeFieldIndex];
    const dataValues = frame.data.values[valueFieldIndex];

    for (let i = 0; i < timeValues.length; i++) {
      const timestamp = new Date(timeValues[i]).toISOString();
      const value = dataValues[i];

      // Skip null values
      if (value === null || value === undefined) {
        continue;
      }

      // Build label set for this point
      const pointLabels = { ...labels };
      labelFields.forEach((fieldName, fieldIndex) => {
        const fieldValue = frame.data.values[fieldIndex]?.[i];
        if (fieldValue !== null && fieldValue !== undefined) {
          pointLabels[fieldName] = String(fieldValue);
        }
      });

      // Add metric value as a special label
      pointLabels["__value__"] = String(value);
      pointLabels["__name__"] = metricName;

      yield {
        timestamp,
        source: "prometheus",
        message: `${metricName}${this.formatLabels(pointLabels)} ${value}`,
        labels: pointLabels,
        joinKeys: this.extractJoinKeys(pointLabels),
      };
    }
  }

  /**
   * Parse legacy series format
   */
  private async *parseLegacySeries(series: any[]): AsyncIterable<LogEvent> {
    for (const serie of series) {
      const labels = serie.tags || serie.labels || {};
      const metricName = serie.name || serie.target || "value";
      
      // Add metric name to labels
      labels["__name__"] = metricName;

      for (const point of serie.points || serie.datapoints || []) {
        // Points can be [value, timestamp] or [timestamp, value]
        const [val, ts] = Array.isArray(point) ? point : [point.value, point.timestamp];
        
        // Skip null values
        if (val === null || val === undefined) {
          continue;
        }

        const timestamp = new Date(ts).toISOString();
        const value = typeof val === "number" ? val : parseFloat(val);
        
        // Add value as special label
        const eventLabels = {
          ...labels,
          "__value__": String(value),
        };

        yield {
          timestamp,
          source: "prometheus",
          message: `${metricName}${this.formatLabels(labels)} ${value}`,
          labels: eventLabels,
          joinKeys: this.extractJoinKeys(eventLabels),
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
      if (key === "__value__" || key === "__name__") continue;
      pairs.push(`${key}="${value}"`);
    }
    return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
  }

  /**
   * Extract join keys from labels
   */
  private extractJoinKeys(labels: Record<string, string>): Record<string, string> {
    const joinKeys: Record<string, string> = {};
    
    // Common correlation keys in metrics
    const correlationKeys = [
      "job",
      "instance",
      "pod",
      "namespace",
      "service",
      "deployment",
      "node",
      "container",
      "trace_id",
      "span_id",
      "request_id",
      "transaction_id",
      "correlation_id",
    ];

    for (const key of correlationKeys) {
      if (labels[key]) {
        joinKeys[key] = labels[key];
      }
    }

    return joinKeys;
  }

  /**
   * Execute instant query (for current values)
   */
  async executeInstantQuery(
    query: string,
    time?: Date
  ): Promise<any> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    const timestamp = time ? time.getTime().toString() : "now";

    const queryRequest = {
      queries: [
        {
          datasource: { uid: dataSource.uid },
          expr: query,
          refId: "A",
          format: "table",
          instant: true,
          range: false,
        },
      ],
      from: timestamp,
      to: timestamp,
    };

    const response = await this.makeRequest("/api/ds/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(queryRequest),
    });

    if (!response.ok) {
      throw new Error(`Instant query failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get metric metadata
   */
  async getMetadata(metric?: string): Promise<any> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    
    // Use Grafana's resource API to get metadata
    const path = metric 
      ? `/api/datasources/uid/${dataSource.uid}/resources/api/v1/metadata?metric=${metric}`
      : `/api/datasources/uid/${dataSource.uid}/resources/api/v1/metadata`;

    const response = await this.makeRequest(path, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get label names
   */
  async getLabelNames(): Promise<string[]> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    
    const response = await this.makeRequest(
      `/api/datasources/uid/${dataSource.uid}/resources/api/v1/labels`,
      { method: "GET" }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch labels: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data || [];
  }

  /**
   * Get label values for a specific label
   */
  async getLabelValues(label: string): Promise<string[]> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    
    const response = await this.makeRequest(
      `/api/datasources/uid/${dataSource.uid}/resources/api/v1/label/${label}/values`,
      { method: "GET" }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch label values: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data || [];
  }
}