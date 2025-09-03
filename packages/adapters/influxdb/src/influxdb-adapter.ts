import {
  DataSourceAdapter,
  LogEvent,
  CorrelationError,
  StreamOptions,
  isGrafanaUrl,
} from "@timebridge/core";
import fetch, { RequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import { influxQLParser } from "./influxql-parser";
import { InfluxDBGrafanaProxy } from "./influxdb-grafana-proxy";

export interface InfluxDBAdapterOptions {
  url: string;
  database?: string; // Optional when using Grafana
  username?: string;
  password?: string;
  token?: string; // For InfluxDB 2.x
  authToken?: string; // Alternative to token for Grafana consistency
  datasourceName?: string; // Grafana data source name
  org?: string; // For InfluxDB 2.x
  bucket?: string; // For InfluxDB 2.x (replaces database)
  version?: "1.x" | "2.x"; // Default to 1.x for backward compatibility
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  precision?: "ns" | "u" | "ms" | "s" | "m" | "h"; // Time precision
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    type?: 4 | 5; // SOCKS4 or SOCKS5, defaults to 5
  };
  grafanaOptions?: {
    refreshDataSources?: boolean;
    datasourceCacheTTL?: number;
    maxRetries?: number;
    timeout?: number;
  };
}

interface InfluxDBQueryResponse {
  results?: Array<{
    series?: Array<{
      name: string;
      columns: string[];
      values: any[][];
      tags?: Record<string, string>;
    }>;
    error?: string;
  }>;
  error?: string;
}

// Currently unused but kept for future InfluxDB 2.x enhancements
// interface InfluxDB2QueryResponse {
//   type?: string;
//   result?: string;
//   table?: number;
//   _start?: string;
//   _stop?: string;
//   _time?: string;
//   _value?: any;
//   _field?: string;
//   _measurement?: string;
//   [key: string]: any;
// }

export class InfluxDBAdapter implements DataSourceAdapter {
  private authHeader: string = "";
  private abortController?: AbortController;
  private proxyAgent?: SocksProxyAgent;
  private isV2: boolean;
  private grafanaProxy?: InfluxDBGrafanaProxy;
  private isGrafana?: boolean;

  constructor(private options: InfluxDBAdapterOptions) {
    // Initialize detection first
    this.detectAndSetupGrafana();

    // Validate configuration (skip some checks for Grafana)
    this.isV2 = options.version === "2.x";

    if (!this.isGrafana) {
      if (this.isV2) {
        // InfluxDB 2.x validation
        if (!options.org || !options.bucket) {
          throw new CorrelationError(
            "InfluxDB 2.x requires 'org' and 'bucket' configuration",
            "CONFIG_ERROR"
          );
        }
        const effectiveToken = options.authToken || options.token;
        if (!effectiveToken) {
          throw new CorrelationError(
            "InfluxDB 2.x requires a token for authentication",
            "CONFIG_ERROR"
          );
        }
        this.authHeader = `Token ${effectiveToken}`;
      } else {
        // InfluxDB 1.x validation
        if (!options.database) {
          throw new CorrelationError(
            "InfluxDB 1.x requires 'database' configuration",
            "CONFIG_ERROR"
          );
        }
        // Setup Basic auth for 1.x if credentials provided
        if (options.username && options.password) {
          const credentials = Buffer.from(
            `${options.username}:${options.password}`
          ).toString("base64");
          this.authHeader = `Basic ${credentials}`;
        }
      }
    }

    // Create SOCKS proxy agent if configured
    if (this.options.proxy) {
      const { host, port, username, password, type = 5 } = this.options.proxy;
      const auth = username && password ? `${username}:${password}@` : "";
      const proxyUrl = `socks${type}://${auth}${host}:${port}`;
      this.proxyAgent = new SocksProxyAgent(proxyUrl);
    }
  }

  private detectGrafana(): void {
    // Synchronous initial detection - async setup happens separately
    this.isGrafana = false;
  }

  private async detectAndSetupGrafana(): Promise<void> {
    try {
      // Build auth header for detection
      let authHeader = "";
      const effectiveToken = this.options.authToken || this.options.token;
      if (effectiveToken) {
        authHeader = effectiveToken.startsWith("Bearer ") 
          ? effectiveToken 
          : `Bearer ${effectiveToken}`;
      } else if (this.options.username && this.options.password) {
        const credentials = Buffer.from(
          `${this.options.username}:${this.options.password}`
        ).toString("base64");
        authHeader = `Basic ${credentials}`;
      }
      
      // Quick detection check
      this.isGrafana = await isGrafanaUrl(this.options.url, authHeader);
      
      if (this.isGrafana) {
        // Create Grafana proxy
        this.grafanaProxy = new InfluxDBGrafanaProxy({
          grafanaUrl: this.options.url,
          authToken: authHeader,
          basicAuth: this.options.username && this.options.password ? {
            username: this.options.username,
            password: this.options.password,
          } : undefined,
          datasourceName: this.options.datasourceName,
          proxy: this.options.proxy,
          timeout: this.options.timeout,
          maxRetries: this.options.maxRetries,
          grafanaOptions: this.options.grafanaOptions,
        });
      }
    } catch (error) {
      // Detection failed, assume direct connection
      this.isGrafana = false;
    }
  }

  async *createStream(
    query: string,
    options?: StreamOptions
  ): AsyncIterable<LogEvent> {
    // Check if we should use Grafana proxy
    if (this.grafanaProxy) {
      const timeRange = this.parseTimeRangeToDate(options?.timeRange || "5m");
      yield* await this.grafanaProxy.executeQuery(query, timeRange);
      return;
    }

    // Direct InfluxDB connection
    const timeRange = options?.timeRange || "5m";
    const limit = options?.limit || 10000;

    // Parse and enhance the query with time constraints
    const enhancedQuery = this.enhanceQueryWithTimeRange(query, timeRange);

    if (this.options.pollInterval && this.options.pollInterval > 0) {
      // Polling mode - continuously fetch new data
      yield* this.createPollingStream(enhancedQuery, limit);
    } else {
      // One-time query
      yield* this.queryData(enhancedQuery, limit);
    }
  }

  private parseTimeRangeToDate(timeRange: string): { from: Date; to: Date } {
    const now = new Date();
    const match = timeRange.match(/^(\d+)([smhd])$/);
    
    if (!match) {
      // Default to 5 minutes
      return {
        from: new Date(now.getTime() - 5 * 60 * 1000),
        to: now,
      };
    }

    const value = parseInt(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const rangeMs = value * (multipliers[unit] || 60000);
    return {
      from: new Date(now.getTime() - rangeMs),
      to: now,
    };
  }

  private enhanceQueryWithTimeRange(query: string, timeRange: string): string {
    // const duration = this.parseTimeRange(timeRange);

    if (this.isV2) {
      // For InfluxDB 2.x, we use Flux query language
      // Wrap the query with time range if not already present
      if (!query.includes("range(")) {
        const bucket = this.options.bucket;
        return `from(bucket: "${bucket}") |> range(start: -${timeRange}) |> ${query}`;
      }
      return query;
    } else {
      // For InfluxDB 1.x, use the parser to properly add time constraints
      if (influxQLParser.hasTimeConstraint(query)) {
        return query; // Already has time constraint
      }
      
      try {
        // Use parser to add time constraint properly
        return influxQLParser.addTimeConstraint(query, timeRange);
      } catch (error) {
        // Fallback to string manipulation if parser fails
        console.warn('Failed to parse InfluxQL, using fallback:', error);
        
        // Add time constraint to the query
        const whereClause = query.toUpperCase().includes("WHERE")
          ? ` AND time > now() - ${timeRange}`
          : ` WHERE time > now() - ${timeRange}`;

        // Insert before ORDER BY, LIMIT, or at the end
        const orderByIndex = query.toUpperCase().indexOf("ORDER BY");
        const limitIndex = query.toUpperCase().indexOf("LIMIT");
        const insertIndex =
          orderByIndex > -1
            ? orderByIndex
            : limitIndex > -1
            ? limitIndex
            : query.length;

        return (
          query.slice(0, insertIndex) + whereClause + query.slice(insertIndex)
        );
      }
    }
  }

  private async *createPollingStream(
    query: string,
    limit: number
  ): AsyncIterable<LogEvent> {
    this.abortController = new AbortController();
    const seenPoints = new Set<string>();

    while (!this.abortController.signal.aborted) {
      try {
        const events = await this.fetchData(query, limit);

        // Only yield new events (deduplication)
        for (const event of events) {
          const key = `${event.timestamp}-${JSON.stringify(event.labels)}`;
          if (!seenPoints.has(key)) {
            seenPoints.add(key);
            yield event;
          }
        }

        // Clean up old entries to prevent memory growth
        if (seenPoints.size > limit * 2) {
          const entries = Array.from(seenPoints);
          entries.splice(0, entries.length - limit);
          seenPoints.clear();
          entries.forEach((e) => seenPoints.add(e));
        }

        // Wait before next poll
        await this.sleep(this.options.pollInterval!);
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          break;
        }
        console.error("InfluxDB polling error:", error);
        // Continue polling after error with backoff
        await this.sleep(Math.min(this.options.pollInterval! * 2, 30000));
      }
    }
  }

  private async *queryData(
    query: string,
    limit: number
  ): AsyncIterable<LogEvent> {
    const events = await this.fetchData(query, limit);
    for (const event of events) {
      yield event;
    }
  }

  private async fetchData(query: string, limit: number): Promise<LogEvent[]> {
    if (this.isV2) {
      return this.fetchDataV2(query, limit);
    } else {
      return this.fetchDataV1(query, limit);
    }
  }

  private async fetchDataV1(query: string, limit: number): Promise<LogEvent[]> {
    const url = `${this.options.url}/query`;
    const params: Record<string, string> = {
      q: query,
      epoch: this.options.precision || "ms",
    };
    
    if (this.options.database) {
      params.db = this.options.database;
    }

    const queryParams = new URLSearchParams(params);

    const fetchOptions: RequestInit = {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      timeout: this.options.timeout || 30000,
    };

    if (this.authHeader) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        Authorization: this.authHeader,
      };
    }

    if (this.abortController) {
      fetchOptions.signal = this.abortController.signal;
    }

    if (this.proxyAgent) {
      (fetchOptions as any).agent = this.proxyAgent;
    }

    const response = await fetch(`${url}?${queryParams}`, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new CorrelationError(
        `InfluxDB query failed: ${response.statusText} - ${errorBody}`,
        "INFLUXDB_QUERY_ERROR",
        { status: response.status, body: errorBody }
      );
    }

    const result = (await response.json()) as InfluxDBQueryResponse;

    if (result.error) {
      throw new CorrelationError(
        `InfluxDB query error: ${result.error}`,
        "INFLUXDB_QUERY_ERROR"
      );
    }

    return this.transformV1ResponseToEvents(result, limit);
  }

  private async fetchDataV2(query: string, limit: number): Promise<LogEvent[]> {
    const url = `${this.options.url}/api/v2/query`;

    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        Accept: "application/csv",
        "Content-Type": "application/vnd.flux",
        Authorization: this.authHeader,
      },
      body: query,
      timeout: this.options.timeout || 30000,
    };

    if (this.options.org) {
      (fetchOptions.headers as any)["Influx-Org"] = this.options.org;
    }

    if (this.abortController) {
      fetchOptions.signal = this.abortController.signal;
    }

    if (this.proxyAgent) {
      (fetchOptions as any).agent = this.proxyAgent;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new CorrelationError(
        `InfluxDB 2.x query failed: ${response.statusText} - ${errorBody}`,
        "INFLUXDB_QUERY_ERROR",
        { status: response.status, body: errorBody }
      );
    }

    const csvData = await response.text();
    return this.transformV2ResponseToEvents(csvData, limit);
  }

  private transformV1ResponseToEvents(
    response: InfluxDBQueryResponse,
    limit: number
  ): LogEvent[] {
    const events: LogEvent[] = [];

    if (!response.results) {
      return events;
    }

    for (const result of response.results) {
      if (!result.series) continue;

      for (const series of result.series) {
        const { name, columns, values, tags = {} } = series;

        if (!values) continue;

        const timeIndex = columns.indexOf("time");
        if (timeIndex === -1) continue;

        for (const row of values) {
          if (events.length >= limit) break;

          const timestamp = this.formatTimestamp(row[timeIndex]);

          // Build labels from columns and values
          const labels: Record<string, string> = {
            ...tags,
            _measurement: name,
          };
          const fields: Record<string, any> = {};

          for (let i = 0; i < columns.length; i++) {
            if (i !== timeIndex && row[i] !== null && row[i] !== undefined) {
              const columnName = columns[i];
              labels[columnName] = String(row[i]);
              fields[columnName] = row[i];
            }
          }

          // Extract correlation IDs
          const joinKeys = this.extractJoinKeys(labels);

          // Create a human-readable message
          const fieldEntries = Object.entries(fields)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          const message = `${name}: ${fieldEntries}`;

          events.push({
            timestamp,
            source: "influxdb",
            message,
            labels,
            joinKeys,
          });
        }

        if (events.length >= limit) break;
      }
    }

    return events;
  }

  private transformV2ResponseToEvents(
    csvData: string,
    limit: number
  ): LogEvent[] {
    const events: LogEvent[] = [];
    const lines = csvData.split("\n");

    let headers: string[] = [];
    let currentTable = -1;

    for (const line of lines) {
      if (!line.trim()) continue;

      const values = this.parseCSVLine(line);

      if (values.length === 0) continue;

      // Check for table marker
      if (values[0] === "" && values.length > 2) {
        // New table header
        headers = values.slice(1);
        currentTable++;
        continue;
      }

      // Skip annotation rows
      if (values[0] === "#" || values[0].startsWith("#")) continue;

      // Process data row
      if (headers.length > 0) {
        const row: Record<string, any> = {};
        for (let i = 0; i < Math.min(headers.length, values.length); i++) {
          if (headers[i]) {
            row[headers[i]] = values[i];
          }
        }

        if (row._time) {
          const labels: Record<string, string> = {};
          const fields: Record<string, any> = {};

          // Process all fields
          for (const [key, value] of Object.entries(row)) {
            if (key.startsWith("_")) {
              // System fields
              if (key === "_time") continue;
              if (key === "_value") {
                fields.value = value;
                labels.__value__ = String(value);
              } else {
                labels[key] = String(value);
              }
            } else {
              // Tags and fields
              labels[key] = String(value);
              fields[key] = value;
            }
          }

          const timestamp = this.formatTimestamp(row._time);
          const joinKeys = this.extractJoinKeys(labels);

          const measurement = row._measurement || "measurement";
          const fieldName = row._field || "value";
          const message = `${measurement}.${fieldName}=${row._value || ""}`;

          events.push({
            timestamp,
            source: "influxdb",
            message,
            labels: {
              ...labels,
              _table: String(currentTable),
            },
            joinKeys,
          });

          if (events.length >= limit) break;
        }
      }
    }

    return events;
  }

  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    values.push(current);
    return values;
  }

  private extractJoinKeys(
    labels: Record<string, string>
  ): Record<string, string> {
    const joinKeys: Record<string, string> = {};
    const correlationFields = [
      "request_id",
      "trace_id",
      "span_id",
      "correlation_id",
      "session_id",
      "transaction_id",
      "job_id",
      "task_id",
    ];

    for (const field of correlationFields) {
      if (labels[field]) {
        joinKeys[field] = labels[field];
      }
    }

    return joinKeys;
  }

  private formatTimestamp(timestamp: any): string {
    if (typeof timestamp === "string") {
      return new Date(timestamp).toISOString();
    } else if (typeof timestamp === "number") {
      // Handle different precisions
      let ms = timestamp;
      switch (this.options.precision) {
        case "ns":
          ms = timestamp / 1000000;
          break;
        case "u":
          ms = timestamp / 1000;
          break;
        case "ms":
          // Already in milliseconds
          break;
        case "s":
          ms = timestamp * 1000;
          break;
        case "m":
          ms = timestamp * 60000;
          break;
        case "h":
          ms = timestamp * 3600000;
          break;
        default:
          // Assume milliseconds by default
          break;
      }
      return new Date(ms).toISOString();
    }
    return new Date().toISOString();
  }

  private parseTimeRange(timeRange: string): number {
    const match = timeRange.match(/^(\d+)([smhdw])$/);
    if (!match) {
      throw new CorrelationError(
        `Invalid time range: ${timeRange}`,
        "INVALID_TIME_RANGE"
      );
    }

    const [, value, unit] = match;
    const num = parseInt(value, 10);

    switch (unit) {
      case "s":
        return num * 1000;
      case "m":
        return num * 60 * 1000;
      case "h":
        return num * 60 * 60 * 1000;
      case "d":
        return num * 24 * 60 * 60 * 1000;
      case "w":
        return num * 7 * 24 * 60 * 60 * 1000;
      default:
        throw new CorrelationError(
          `Unknown time unit: ${unit}`,
          "INVALID_TIME_UNIT"
        );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  validateQuery(query: string): boolean {
    // Use the InfluxQL parser for proper validation
    const result = influxQLParser.validate(query);
    
    if (!result.valid && result.errors) {
      console.warn('InfluxQL validation errors:', result.errors);
    }
    
    return result.valid;
  }

  getName(): string {
    return "influxdb";
  }

  async destroy(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
