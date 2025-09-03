import {
  DataSourceAdapter,
  LogEvent,
  CorrelationError,
  StreamOptions,
  isGrafanaUrl,
} from "@timebridge/core";
import fetch, { RequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import { PromQLParser } from "./promql-parser";
import { PrometheusGrafanaProxy } from "./prometheus-grafana-proxy";

export interface PrometheusAdapterOptions {
  url: string;
  username?: string;
  password?: string;
  apiToken?: string;
  authToken?: string; // Alternative to apiToken for consistency
  datasourceName?: string; // Grafana data source name
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  step?: string; // Query resolution step (e.g., "15s", "1m")
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

interface PrometheusQueryResponse {
  status: string;
  data: {
    resultType: "matrix" | "vector" | "scalar" | "string";
    result: Array<{
      metric: Record<string, string>;
      values?: Array<[number, string]>; // For matrix
      value?: [number, string]; // For vector/scalar
    }>;
  };
  error?: string;
  errorType?: string;
}

export class PrometheusAdapter implements DataSourceAdapter {
  private authHeader: string;
  private abortController?: AbortController;
  private proxyAgent?: SocksProxyAgent;
  private parser: PromQLParser;
  private grafanaProxy?: PrometheusGrafanaProxy;
  private isGrafana?: boolean;

  constructor(private options: PrometheusAdapterOptions) {
    // Validate URL
    if (!options.url) {
      throw new CorrelationError("Prometheus URL is required", "CONFIG_ERROR");
    }

    // Initialize parser
    this.parser = new PromQLParser();

    // Setup authentication - support both apiToken and authToken
    const token = options.authToken || options.apiToken;
    if (token) {
      this.authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    } else if (options.username && options.password) {
      const credentials = Buffer.from(
        `${options.username}:${options.password}`
      ).toString("base64");
      this.authHeader = `Basic ${credentials}`;
    } else {
      this.authHeader = "";
    }

    // Create SOCKS proxy agent if configured
    if (this.options.proxy) {
      const { host, port, username, password, type = 5 } = this.options.proxy;
      const auth = username && password ? `${username}:${password}@` : "";
      const proxyUrl = `socks${type}://${auth}${host}:${port}`;
      this.proxyAgent = new SocksProxyAgent(proxyUrl);
    }

    // Check if this is a Grafana instance and setup proxy
    this.detectAndSetupGrafana();
  }

  private async detectAndSetupGrafana(): Promise<void> {
    try {
      // Quick detection check
      this.isGrafana = await isGrafanaUrl(this.options.url, this.authHeader);
      
      if (this.isGrafana) {
        // Create Grafana proxy
        this.grafanaProxy = new PrometheusGrafanaProxy({
          grafanaUrl: this.options.url,
          authToken: this.authHeader,
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
      const timeRange = this.parseTimeRange(options?.timeRange || "5m");
      yield* await this.grafanaProxy.executeQuery(query, timeRange);
      return;
    }

    // Direct Prometheus connection
    const timeRange = options?.timeRange || "5m";
    const limit = options?.limit || 10000;

    // For Prometheus, we interpret the query as a PromQL expression
    // It could be a simple metric name, or a complex PromQL query
    const promqlQuery = this.sanitizeQuery(query);

    if (this.options.pollInterval && this.options.pollInterval > 0) {
      // Polling mode - continuously fetch new data
      yield* this.createPollingStream(promqlQuery, timeRange, limit);
    } else {
      // One-time query
      yield* this.queryMetrics(promqlQuery, timeRange, limit);
    }
  }

  private parseTimeRange(timeRange: string): { from: Date; to: Date } {
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

  private sanitizeQuery(query: string): string {
    // Remove any wrapping quotes
    return query.replace(/^["']|["']$/g, "").trim();
  }

  private async *createPollingStream(
    query: string,
    timeRange: string,
    limit: number
  ): AsyncIterable<LogEvent> {
    this.abortController = new AbortController();
    const seenTimestamps = new Set<string>();

    while (!this.abortController.signal.aborted) {
      try {
        const events = await this.fetchMetrics(query, timeRange, limit);

        // Only yield new events (deduplication)
        for (const event of events) {
          const key = `${event.timestamp}-${JSON.stringify(event.labels)}`;
          if (!seenTimestamps.has(key)) {
            seenTimestamps.add(key);
            yield event;
          }
        }

        // Clean up old entries to prevent memory growth
        if (seenTimestamps.size > limit * 2) {
          const entries = Array.from(seenTimestamps);
          entries.splice(0, entries.length - limit);
          seenTimestamps.clear();
          entries.forEach((e) => seenTimestamps.add(e));
        }

        // Wait before next poll
        await this.sleep(this.options.pollInterval!);
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          break;
        }
        console.error("Prometheus polling error:", error);
        // Continue polling after error with backoff
        await this.sleep(Math.min(this.options.pollInterval! * 2, 30000));
      }
    }
  }

  private async *queryMetrics(
    query: string,
    timeRange: string,
    limit: number
  ): AsyncIterable<LogEvent> {
    const events = await this.fetchMetrics(query, timeRange, limit);
    for (const event of events) {
      yield event;
    }
  }

  private async fetchMetrics(
    query: string,
    timeRange: string,
    limit: number
  ): Promise<LogEvent[]> {
    const now = Date.now();
    const duration = this.parseTimeRangeToMs(timeRange);
    const start = Math.floor((now - duration) / 1000);
    const end = Math.floor(now / 1000);

    // Calculate appropriate step based on time range and desired resolution
    // Aim for ~100-300 data points for good visualization
    const desiredPoints = 200;
    const minStep = 15; // Minimum 15 seconds
    const step = Math.max(minStep, Math.floor((end - start) / desiredPoints));

    const params = {
      query,
      start: start.toString(),
      end: end.toString(),
      step: this.options.step || `${step}s`,
    };

    const response = await this.queryPrometheus(params);
    return this.transformMetricsToEvents(response, limit);
  }

  private async queryPrometheus(params: {
    query: string;
    start: string;
    end: string;
    step: string;
  }): Promise<PrometheusQueryResponse> {
    const url = `${this.options.url}/api/v1/query_range`;
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
        `Prometheus query failed: ${response.statusText} - ${errorBody}`,
        "PROMETHEUS_QUERY_ERROR",
        { status: response.status, body: errorBody }
      );
    }

    const result = (await response.json()) as PrometheusQueryResponse;

    if (result.status === "error") {
      throw new CorrelationError(
        `Prometheus query error: ${result.error}`,
        "PROMETHEUS_QUERY_ERROR",
        { errorType: result.errorType }
      );
    }

    return result;
  }

  private transformMetricsToEvents(
    response: PrometheusQueryResponse,
    limit: number
  ): LogEvent[] {
    const events: LogEvent[] = [];

    // Handle different result types
    if (
      response.data.resultType === "scalar" ||
      response.data.resultType === "string"
    ) {
      // Scalar/string results
      if (response.data.result && response.data.result.length > 0) {
        const result = response.data.result[0] as any;
        const [timestamp, value] = result;

        events.push(this.createMetricEvent(timestamp, value, {}, "scalar"));
      }
      return events;
    }

    // Handle matrix and vector results
    for (const series of response.data.result) {
      const { metric, values, value } = series;

      // Vector result has a single value
      if (value && !values) {
        const [timestamp, val] = value;
        events.push(this.createMetricEvent(timestamp, val, metric, "instant"));
        continue;
      }

      // Matrix result has multiple values
      if (values) {
        for (const [timestamp, val] of values) {
          if (events.length >= limit) break;
          events.push(this.createMetricEvent(timestamp, val, metric, "range"));
        }
      }

      if (events.length >= limit) break;
    }

    return events;
  }

  private createMetricEvent(
    timestamp: number,
    value: string,
    labels: Record<string, string>,
    queryType: string
  ): LogEvent {
    // Convert Unix timestamp to ISO string
    const isoTimestamp = new Date(timestamp * 1000).toISOString();

    // Extract potential join keys from labels
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

    // Build a human-readable message
    const metricName = labels.__name__ || labels.metric_name || "metric";
    const message = `${metricName}=${value}`;

    return {
      timestamp: isoTimestamp,
      source: "prometheus",
      message,
      labels: {
        ...labels,
        __value__: value,
        __query_type__: queryType,
      },
      joinKeys,
    };
  }

  private parseTimeRangeToMs(timeRange: string): number {
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
    // Use the parser for comprehensive validation
    const result = this.parser.validate(query);

    // Log any errors or warnings for debugging
    if (!result.valid && result.errors) {
      console.error("PromQL validation errors:", result.errors);
    }
    if (result.warnings) {
      console.warn("PromQL validation warnings:", result.warnings);
    }

    return result.valid;
  }

  getName(): string {
    return "prometheus";
  }

  async destroy(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
