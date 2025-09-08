import {
  DataSourceAdapter,
  LogEvent,
  CorrelationError,
  isGrafanaUrl,
} from "@timebridge/core";
import fetch from "node-fetch";
import WebSocket from "ws";
import { SocksProxyAgent } from "socks-proxy-agent";
import { LogQLParser } from "./logql-parser";
import { LokiGrafanaProxy } from "./loki-grafana-proxy";

export interface LokiAdapterOptions {
  url: string;
  websocket?: boolean;
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  authToken?: string;
  datasourceName?: string; // Grafana data source name
  headers?: Record<string, string>;
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

interface LokiQueryResponse {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      stream: Record<string, string>;
      values: Array<[string, string]>; // [timestamp_ns, log_line]
    }>;
  };
}

export class LokiAdapter implements DataSourceAdapter {
  private ws?: WebSocket;
  private activeStreams: Set<AbortController> = new Set();
  private reconnectAttempts = 0;
  private heartbeatInterval?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private wsConnectionPromise?: Promise<void>;
  private proxyAgent?: SocksProxyAgent;
  private parser: LogQLParser;
  private grafanaProxy?: LokiGrafanaProxy;
  private isGrafana?: boolean;

  constructor(private options: LokiAdapterOptions) {
    this.options = {
      websocket: true,
      pollInterval: 1000,
      timeout: 30000,
      maxRetries: 3,
      ...options,
    };

    // Initialize LogQL parser
    this.parser = new LogQLParser();

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
      const authHeader = this.options.authToken 
        ? (this.options.authToken.startsWith("Bearer ") 
          ? this.options.authToken 
          : `Bearer ${this.options.authToken}`)
        : "";
      
      this.isGrafana = await isGrafanaUrl(this.options.url, authHeader);
      
      if (this.isGrafana) {
        // Create Grafana proxy
        this.grafanaProxy = new LokiGrafanaProxy({
          grafanaUrl: this.options.url,
          authToken: authHeader,
          datasourceName: this.options.datasourceName,
          headers: this.options.headers,
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

  getName(): string {
    return "loki";
  }

  async *createStream(
    query: string,
    options?: unknown
  ): AsyncIterable<LogEvent> {
    const opts = (options as { 
      timeRange?: string; 
      absoluteTimeRange?: { start: string; end: string };
      at?: string;
    }) || {};
    
    // Check if we should use Grafana proxy
    if (this.grafanaProxy) {
      const timeRange = this.parseTimeRange(opts);
      yield* await this.grafanaProxy.executeQuery(query, timeRange);
      return;
    }

    // Direct Loki connection - for now, convert to old format for compatibility
    const timeRangeStr = opts.timeRange || "5m";

    if (this.options.websocket) {
      yield* this.createWebSocketStream(query, timeRangeStr);
    } else {
      yield* this.createPollingStream(query, timeRangeStr, opts);
    }
  }

  private parseTimeRange(opts: { 
    timeRange?: string; 
    absoluteTimeRange?: { start: string; end: string };
    at?: string;
  }): { from: Date; to: Date } {
    // Handle absolute time ranges
    if (opts.absoluteTimeRange) {
      return {
        from: new Date(opts.absoluteTimeRange.start),
        to: new Date(opts.absoluteTimeRange.end),
      };
    }
    
    // Handle @ modifier
    if (opts.at) {
      const atTime = new Date(opts.at);
      if (opts.timeRange) {
        // Range from specific time
        const rangeMs = this.parseRelativeTimeRangeMs(opts.timeRange);
        return {
          from: atTime,
          to: new Date(atTime.getTime() + rangeMs),
        };
      } else {
        // Point in time (use 1 second window)
        return {
          from: atTime,
          to: new Date(atTime.getTime() + 1000),
        };
      }
    }
    
    // Legacy relative time range
    const timeRange = opts.timeRange || "5m";
    return this.parseRelativeTimeRange(timeRange);
  }
  
  private parseRelativeTimeRangeMs(timeRange: string): number {
    const match = timeRange.match(/^(\d+)([smhdw])$/);
    
    if (!match) {
      // Default to 5 minutes
      return 5 * 60 * 1000;
    }

    const value = parseInt(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };

    return value * (multipliers[unit] || 60000);
  }
  
  private parseRelativeTimeRange(timeRange: string): { from: Date; to: Date } {
    const now = new Date();
    const match = timeRange.match(/^(\d+)([smhdw])$/);
    
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
      w: 7 * 24 * 60 * 60 * 1000,
    };

    const rangeMs = value * (multipliers[unit] || 60000);
    return {
      from: new Date(now.getTime() - rangeMs),
      to: now,
    };
  }

  private async *createWebSocketStream(
    query: string,
    timeRange: string
  ): AsyncIterable<LogEvent> {
    const maxReconnectDelay = 30000; // 30 seconds max
    const baseReconnectDelay = 1000; // Start with 1 second
    const shouldReconnect = true;

    while (
      shouldReconnect &&
      this.reconnectAttempts < this.options.maxRetries!
    ) {
      try {
        yield* this.connectAndStream(query, timeRange);

        // If we get here, stream ended normally
        this.reconnectAttempts = 0;
        break;
      } catch (error) {
        console.error(
          `WebSocket stream error (attempt ${this.reconnectAttempts + 1}):`,
          error
        );

        if (this.reconnectAttempts >= this.options.maxRetries! - 1) {
          throw new CorrelationError(
            "WebSocket connection failed after max retries",
            "WEBSOCKET_MAX_RETRIES",
            { error: error instanceof Error ? error.message : String(error) }
          );
        }

        // Calculate exponential backoff with jitter
        const delay = Math.min(
          baseReconnectDelay * Math.pow(2, this.reconnectAttempts) +
            Math.random() * 1000,
          maxReconnectDelay
        );

        this.reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms...`);

        await new Promise((resolve) => {
          this.reconnectTimeout = setTimeout(resolve, delay);
        });
      }
    }
  }

  private async *connectAndStream(
    query: string,
    _timeRange: string
  ): AsyncIterable<LogEvent> {
    const wsUrl = this.options.url.replace(/^http/, "ws");
    const fullUrl = `${wsUrl}/loki/api/v1/tail?query=${encodeURIComponent(
      query
    )}`;

    const wsOptions: any = {
      headers: this.buildHeaders(),
      handshakeTimeout: this.options.timeout,
    };

    // Add proxy agent for WebSocket if configured
    if (this.proxyAgent) {
      wsOptions.agent = this.proxyAgent;
    }

    const ws = new WebSocket(fullUrl, wsOptions);

    this.ws = ws;

    // Set up connection promise
    this.wsConnectionPromise = new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
        this.setupHeartbeat(ws);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        ws.removeListener("open", onOpen);
        ws.removeListener("error", onError);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);

      // Add connection timeout
      setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          cleanup();
          ws.close();
          reject(new Error("WebSocket connection timeout"));
        }
      }, this.options.timeout!);
    });

    try {
      await this.wsConnectionPromise;
      console.log("WebSocket connected successfully");

      const messageQueue: LogEvent[] = [];
      let resolveNext: ((value: IteratorResult<LogEvent>) => void) | null =
        null;
      let rejectNext: ((error: Error) => void) | null = null;
      let connectionClosed = false;

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const response = JSON.parse(data.toString());

          // Reset heartbeat on any message
          this.resetHeartbeat(ws);

          if (response.streams) {
            for (const stream of response.streams) {
              for (const entry of stream.entries) {
                const event = this.parseLogEntry(stream.stream, entry);
                if (resolveNext) {
                  resolveNext({ value: event, done: false });
                  resolveNext = null;
                  rejectNext = null;
                } else {
                  messageQueue.push(event);
                }
              }
            }
          }
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
          if (rejectNext) {
            rejectNext(error as Error);
            resolveNext = null;
            rejectNext = null;
          }
        }
      });

      ws.on("error", (error) => {
        console.error("WebSocket error:", error);
        connectionClosed = true;
        if (rejectNext) {
          rejectNext(error);
          resolveNext = null;
          rejectNext = null;
        }
      });

      ws.on("close", (code, reason) => {
        console.log(`WebSocket closed: code=${code}, reason=${reason}`);
        connectionClosed = true;
        this.clearHeartbeat();

        // Notify waiting promise if any
        if (rejectNext) {
          rejectNext(new Error(`WebSocket closed: ${reason || code}`));
          resolveNext = null;
          rejectNext = null;
        }
      });

      ws.on("ping", () => {
        // Respond to ping with pong
        if (ws.readyState === WebSocket.OPEN) {
          ws.pong();
        }
      });

      // Yield events as they arrive
      while (!connectionClosed && ws.readyState === WebSocket.OPEN) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        } else {
          // Wait for next message
          yield await new Promise<LogEvent>((resolve, reject) => {
            resolveNext = (result) => {
              if (!result.done) {
                resolve(result.value);
              }
            };
            rejectNext = reject;

            // Check if connection is still alive
            if (connectionClosed || ws.readyState !== WebSocket.OPEN) {
              reject(new Error("WebSocket connection lost"));
            }
          });
        }
      }
    } finally {
      this.clearHeartbeat();
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
      this.ws = undefined;
      this.wsConnectionPromise = undefined;
    }
  }

  private setupHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();

    // Send ping every 30 seconds to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        this.clearHeartbeat();
      }
    }, 30000);
  }

  private resetHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.setupHeartbeat(ws);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private async *createPollingStream(
    query: string,
    _timeRange: string,
    opts?: { 
      timeRange?: string; 
      absoluteTimeRange?: { start: string; end: string };
      at?: string;
    }
  ): AsyncIterable<LogEvent> {
    const controller = new AbortController();
    this.activeStreams.add(controller);
    
    // Parse time range for use in queries
    const timeInfo = this.parseTimeRange(opts || { timeRange: _timeRange });

    try {
      // Use parsed time range for initial query
      let lastTimestamp = timeInfo.from.getTime() * 1000000; // Convert to nanoseconds
      const endTime = timeInfo.to.getTime() * 1000000;

      while (!controller.signal.aborted) {
        const url = `${this.options.url}/loki/api/v1/query_range`;
        const params = new URLSearchParams({
          query,
          start: (lastTimestamp + 1).toString(),
          end: endTime.toString(),
          limit: "1000",
        });

        try {
          const response = await fetch(`${url}?${params}`, {
            method: "GET",
            headers: this.buildHeaders(),
            signal: controller.signal,
            timeout: this.options.timeout,
            agent: this.proxyAgent,
          } as any);

          if (!response.ok) {
            throw new CorrelationError(
              `Loki query failed: ${response.statusText}`,
              "LOKI_QUERY_ERROR",
              { status: response.status }
            );
          }

          const data = (await response.json()) as LokiQueryResponse;

          if (data.status === "success" && data.data.result) {
            for (const stream of data.data.result) {
              for (const [timestamp, logLine] of stream.values) {
                const event = this.parseLogEntry(stream.stream, {
                  ts: timestamp,
                  line: logLine,
                });
                yield event;

                // Update last timestamp
                const eventTimestamp = parseInt(timestamp, 10);
                if (eventTimestamp > lastTimestamp) {
                  lastTimestamp = eventTimestamp;
                }
              }
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          console.error("Polling error:", error);
        }

        // Wait before next poll
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.pollInterval)
        );
      }
    } finally {
      this.activeStreams.delete(controller);
    }
  }

  private parseLogEntry(
    labels: Record<string, string>,
    entry: { ts: string; line: string }
  ): LogEvent {
    // Convert nanosecond timestamp to ISO string
    const timestampMs = parseInt(entry.ts, 10) / 1000000;
    const timestamp = new Date(timestampMs).toISOString();

    // Extract join keys from log line
    const joinKeys = this.extractJoinKeys(entry.line);

    return {
      timestamp,
      source: "loki",
      stream: labels.job || labels.service || "unknown",
      message: entry.line,
      labels,
      joinKeys,
    };
  }

  private extractJoinKeys(logLine: string): Record<string, string> {
    const keys: Record<string, string> = {};

    // Common patterns for extracting IDs
    const patterns = [
      /request[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /trace[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /session[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /correlation[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /span[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
    ];

    for (const pattern of patterns) {
      const match = logLine.match(pattern);
      if (match) {
        const keyName = pattern.source
          .split("[")[0]
          .toLowerCase()
          .replace(/[^a-z]/g, "");
        keys[keyName + "_id"] = match[1];
      }
    }

    return keys;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.options.headers,
    };

    if (this.options.authToken) {
      headers["Authorization"] = this.options.authToken.startsWith("Bearer ")
        ? this.options.authToken
        : `Bearer ${this.options.authToken}`;
    }

    return headers;
  }

  validateQuery(query: string): boolean {
    // Use LogQL parser for comprehensive validation
    const result = this.parser.validate(query);
    
    if (!result.valid && result.errors) {
      console.error("LogQL validation errors:", result.errors);
    }
    
    if (result.warnings) {
      console.warn("LogQL validation warnings:", result.warnings);
    }
    
    return result.valid;
  }

  async getAvailableStreams(): Promise<string[]> {
    const url = `${this.options.url}/loki/api/v1/labels`;

    try {
      const response = await fetch(url, {
        headers: this.buildHeaders(),
        timeout: this.options.timeout,
        agent: this.proxyAgent,
      } as any);

      if (!response.ok) {
        throw new CorrelationError(
          "Failed to fetch available streams",
          "LOKI_LABELS_ERROR"
        );
      }

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error("Failed to get available streams:", error);
      return [];
    }
  }

  async destroy(): Promise<void> {
    // Clear any pending reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    // Clear heartbeat
    this.clearHeartbeat();

    // Close WebSocket if active
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    // Wait for WebSocket connection to close if pending
    if (this.wsConnectionPromise) {
      try {
        await Promise.race([
          this.wsConnectionPromise,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore errors during shutdown
      }
      this.wsConnectionPromise = undefined;
    }

    // Cancel all active polling streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();

    // Reset reconnect attempts
    this.reconnectAttempts = 0;
  }
}
