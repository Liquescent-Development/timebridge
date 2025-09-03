import {
  GrafanaDataSourceProxy,
  GrafanaProxyConfig,
  GrafanaQueryRequest,
  GrafanaQueryResponse,
} from "@timebridge/core/src/grafana/grafana-datasource-proxy";
import { LogEvent } from "@timebridge/core";

/**
 * InfluxDB-specific Grafana proxy implementation
 */
export class InfluxDBGrafanaProxy extends GrafanaDataSourceProxy {
  private influxVersion: "1.x" | "2.x" | undefined;

  constructor(config: GrafanaProxyConfig) {
    super(config);
  }

  getDataSourceType(): string {
    return "influxdb";
  }

  /**
   * Detect InfluxDB version from data source configuration
   */
  private async detectInfluxVersion(): Promise<"1.x" | "2.x"> {
    if (this.influxVersion) {
      return this.influxVersion;
    }

    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    
    // Check jsonData for version hints
    if (dataSource.jsonData) {
      if (dataSource.jsonData.version === "Flux" || dataSource.jsonData.isFlux) {
        this.influxVersion = "2.x";
      } else if (dataSource.jsonData.version === "InfluxQL") {
        this.influxVersion = "1.x";
      } else if (dataSource.jsonData.httpMode === "POST") {
        // Flux queries typically use POST
        this.influxVersion = "2.x";
      }
    }

    // Check by data source type variant
    if (dataSource.type === "influxdb-flux") {
      this.influxVersion = "2.x";
    }

    // Default to 1.x if unclear
    if (!this.influxVersion) {
      this.influxVersion = "1.x";
    }

    return this.influxVersion;
  }

  /**
   * Transform InfluxQL/Flux query to Grafana format
   */
  transformQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ): GrafanaQueryRequest {
    // Note: Version detection happens during query execution, not transformation
    // We'll detect based on query syntax

    if (this.isFluxQuery(query)) {
      return this.transformFluxQuery(query, datasourceUid, timeRange, options);
    } else {
      return this.transformInfluxQLQuery(query, datasourceUid, timeRange, options);
    }
  }

  /**
   * Check if query is Flux (vs InfluxQL)
   */
  private isFluxQuery(query: string): boolean {
    // Flux queries typically start with "from(" or "import"
    const trimmed = query.trim();
    return trimmed.startsWith("from(") || 
           trimmed.startsWith("import ") ||
           trimmed.includes("|>");
  }

  /**
   * Transform InfluxQL query
   */
  private transformInfluxQLQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ): GrafanaQueryRequest {
    // Calculate interval based on time range
    const fromMs = parseInt(timeRange.from);
    const toMs = parseInt(timeRange.to);
    const rangeMs = toMs - fromMs;
    
    // Auto-calculate interval (aim for ~1000 points)
    const intervalMs = Math.max(1000, Math.floor(rangeMs / 1000));
    const interval = this.msToInfluxInterval(intervalMs);

    return {
      queries: [
        {
          datasource: { uid: datasourceUid },
          query: query, // InfluxQL query
          rawQuery: true,
          refId: "A",
          format: "time_series",
          alias: "",
          measurement: this.extractMeasurement(query),
          policy: "default",
          resultFormat: "time_series",
          interval,
          intervalMs,
          maxDataPoints: 1000,
          ...options,
        },
      ],
      from: timeRange.from,
      to: timeRange.to,
    };
  }

  /**
   * Transform Flux query
   */
  private transformFluxQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ): GrafanaQueryRequest {
    // Inject time range into Flux query if not present
    if (!query.includes("range(")) {
      const fromMs = parseInt(timeRange.from);
      const toMs = parseInt(timeRange.to);
      const now = Date.now();
      
      // Convert to relative time if recent
      let rangeStr: string;
      if (Math.abs(toMs - now) < 60000) { // Within 1 minute of now
        const durationMs = toMs - fromMs;
        rangeStr = `range(start: -${this.msToFluxDuration(durationMs)})`;
      } else {
        rangeStr = `range(start: ${new Date(fromMs).toISOString()}, stop: ${new Date(toMs).toISOString()})`;
      }

      // Insert range after from()
      query = query.replace(/from\([^)]+\)/, `$&\n  |> ${rangeStr}`);
    }

    return {
      queries: [
        {
          datasource: { uid: datasourceUid },
          query: query, // Flux query
          refId: "A",
          format: "time_series",
          resultFormat: "time_series",
          maxDataPoints: 1000,
          ...options,
        },
      ],
      from: timeRange.from,
      to: timeRange.to,
    };
  }

  /**
   * Parse Grafana InfluxDB response to LogEvent stream
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
      } else if (result.tables) {
        // Table format response
        yield* this.parseTables(result.tables);
      }
    }
  }

  /**
   * Parse a Grafana data frame
   */
  private async *parseDataFrame(frame: any): AsyncIterable<LogEvent> {
    // Find time and value fields
    let timeFieldIndex = -1;
    const valueFields: Map<number, string> = new Map();
    const tagFields: Map<number, string> = new Map();

    frame.schema.fields.forEach((field: any, index: number) => {
      if (field.type === "time") {
        timeFieldIndex = index;
      } else if (field.type === "number") {
        valueFields.set(index, field.name);
      } else if (field.type === "string") {
        // These are likely tags
        tagFields.set(index, field.name);
      }
    });

    if (timeFieldIndex === -1 || valueFields.size === 0) {
      return; // Invalid frame structure
    }

    // Extract measurement name and tags from frame metadata
    const measurement = frame.schema.meta?.measurement || 
                       frame.name || 
                       "measurement";
    const frameTags = frame.schema.meta?.tags || {};

    // Yield events for each data point
    const timeValues = frame.data.values[timeFieldIndex];

    for (let i = 0; i < timeValues.length; i++) {
      const timestamp = new Date(timeValues[i]).toISOString();

      // Build tags for this point
      const tags: Record<string, string> = { ...frameTags };
      tagFields.forEach((fieldName, fieldIndex) => {
        const value = frame.data.values[fieldIndex]?.[i];
        if (value !== null && value !== undefined) {
          tags[fieldName] = String(value);
        }
      });

      // Build fields for this point
      const fields: Record<string, any> = {};
      valueFields.forEach((fieldName, fieldIndex) => {
        const value = frame.data.values[fieldIndex]?.[i];
        if (value !== null && value !== undefined) {
          fields[fieldName] = value;
        }
      });

      // Format message
      const fieldStr = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const tagStr = this.formatTags(tags);
      const message = `${measurement}${tagStr} ${fieldStr}`;

      // Combine tags and field names for labels
      const labels = {
        ...tags,
        measurement,
        ...Object.keys(fields).reduce((acc, key) => {
          acc[`field_${key}`] = "true";
          return acc;
        }, {} as Record<string, string>),
      };

      yield {
        timestamp,
        source: "influxdb",
        stream: measurement,
        message,
        labels,
        joinKeys: this.extractJoinKeys(tags),
      };
    }
  }

  /**
   * Parse legacy series format
   */
  private async *parseLegacySeries(series: any[]): AsyncIterable<LogEvent> {
    for (const serie of series) {
      const measurement = serie.name || serie.target || "measurement";
      const tags = serie.tags || {};
      const columns = serie.columns || [];
      const values = serie.values || serie.points || [];

      // Find time column index
      const timeIndex = columns.indexOf("time") >= 0 
        ? columns.indexOf("time")
        : columns.indexOf("Time") >= 0 
        ? columns.indexOf("Time") 
        : 0;

      for (const row of values) {
        const timestamp = new Date(row[timeIndex]).toISOString();

        // Build fields from row data
        const fields: Record<string, any> = {};
        columns.forEach((col: string, index: number) => {
          if (index !== timeIndex && col !== "time" && col !== "Time") {
            if (row[index] !== null && row[index] !== undefined) {
              fields[col] = row[index];
            }
          }
        });

        // Format message
        const fieldStr = Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        const tagStr = this.formatTags(tags);
        const message = `${measurement}${tagStr} ${fieldStr}`;

        const labels = {
          ...tags,
          measurement,
        };

        yield {
          timestamp,
          source: "influxdb",
          stream: measurement,
          message,
          labels,
          joinKeys: this.extractJoinKeys(tags),
        };
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

      // Find time column
      const timeCol = columns.find((c: any) => 
        c.text === "Time" || c.text === "time" || c.type === "time"
      );
      const timeIndex = timeCol ? columns.indexOf(timeCol) : -1;

      if (timeIndex === -1) continue;

      // Extract measurement from table name or first tag
      const measurement = table.name || "measurement";

      for (const row of rows) {
        const timestamp = new Date(row[timeIndex]).toISOString();

        // Build fields and tags
        const fields: Record<string, any> = {};
        const tags: Record<string, string> = {};

        columns.forEach((col: any, index: number) => {
          if (index === timeIndex) return;

          const value = row[index];
          if (value === null || value === undefined) return;

          // Determine if tag or field based on column metadata or value type
          if (col.type === "string" || typeof value === "string") {
            tags[col.text] = String(value);
          } else {
            fields[col.text] = value;
          }
        });

        // Format message
        const fieldStr = Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        const tagStr = this.formatTags(tags);
        const message = `${measurement}${tagStr} ${fieldStr}`;

        const labels = {
          ...tags,
          measurement,
        };

        yield {
          timestamp,
          source: "influxdb",
          stream: measurement,
          message,
          labels,
          joinKeys: this.extractJoinKeys(tags),
        };
      }
    }
  }

  /**
   * Format tags for display
   */
  private formatTags(tags: Record<string, string>): string {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(tags)) {
      pairs.push(`${key}=${value}`);
    }
    return pairs.length > 0 ? `,${pairs.join(",")}` : "";
  }

  /**
   * Extract measurement name from query
   */
  private extractMeasurement(query: string): string {
    const match = query.match(/FROM\s+"?([^"\s]+)"?/i);
    return match ? match[1] : "measurement";
  }

  /**
   * Convert milliseconds to InfluxDB interval
   */
  private msToInfluxInterval(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
    return `${Math.floor(ms / 86400000)}d`;
  }

  /**
   * Convert milliseconds to Flux duration
   */
  private msToFluxDuration(ms: number): string {
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
    return `${Math.floor(ms / 86400000)}d`;
  }

  /**
   * Extract join keys from tags
   */
  private extractJoinKeys(tags: Record<string, string>): Record<string, string> {
    const joinKeys: Record<string, string> = {};
    
    // Common correlation keys in time series data
    const correlationKeys = [
      "host",
      "server",
      "instance",
      "node",
      "cluster",
      "service",
      "application",
      "environment",
      "region",
      "datacenter",
      "request_id",
      "transaction_id",
      "trace_id",
      "session_id",
    ];

    for (const key of correlationKeys) {
      if (tags[key]) {
        joinKeys[key] = tags[key];
      }
    }

    return joinKeys;
  }

  /**
   * Get available measurements
   */
  async getMeasurements(): Promise<string[]> {
    const dataSource = await this.resolveDataSource(this.config.datasourceName);
    const version = await this.detectInfluxVersion();

    if (version === "1.x") {
      // Use InfluxQL SHOW MEASUREMENTS
      const queryRequest = {
        queries: [
          {
            datasource: { uid: dataSource.uid },
            query: "SHOW MEASUREMENTS",
            refId: "A",
            format: "table",
          },
        ],
        from: "now-1h",
        to: "now",
      };

      const response = await this.makeRequest("/api/ds/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(queryRequest),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch measurements: ${response.statusText}`);
      }

      const result = await response.json();
      // Extract measurement names from response
      const measurements: string[] = [];
      // Parse based on actual response structure
      return measurements;
    } else {
      // For Flux, measurements are "buckets"
      // This would need a different approach
      return [];
    }
  }
}