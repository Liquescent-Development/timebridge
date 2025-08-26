import {
  DataSourceAdapter,
  LogEvent,
  CorrelationError,
} from "@liquescent/log-correlator-core";
import fetch, { RequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface GraylogAdapterOptions {
  url: string;
  username?: string;
  password?: string;
  apiToken?: string;
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  streamId?: string; // MongoDB ObjectId of the stream (24 hex chars)
  streamName?: string; // Human-readable stream name (will be resolved to ID)
  apiVersion?: "legacy" | "v6"; // 'legacy' for universal search, 'v6' for views API
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    type?: 4 | 5; // SOCKS4 or SOCKS5, defaults to 5
  };
}

interface GraylogMessage {
  message: string;
  timestamp: string;
  source: string;
  fields: Record<string, unknown>;
  _id: string;
}

interface GraylogSearchResponse {
  messages: Array<{
    message: GraylogMessage;
    index: string;
  }>;
  total_results: number;
  from: string;
  to: string;
}

// Graylog 6.x views API response format
// Currently unused but kept for future enhancements
// interface GraylogViewsMessage {
//   _id: string;
//   timestamp: string;
//   message: string;
//   source?: string;
//   [key: string]: unknown; // Additional fields
// }

// Note: GraylogViewsSearchRequest interface removed as we're using
// the simpler /api/views/search/messages format which is different
// from the complex views/search/sync endpoint

export class GraylogAdapter implements DataSourceAdapter {
  private activeStreams: Set<AbortController> = new Set();
  private authHeader: string;
  private proxyAgent?: SocksProxyAgent;
  private resolvedStreamId?: string;
  private streamResolutionPromise?: Promise<void>;

  constructor(private options: GraylogAdapterOptions) {
    this.options = {
      pollInterval: 2000,
      timeout: 15000,
      maxRetries: 3,
      apiVersion: "legacy", // Default to legacy for backward compatibility
      ...options,
    };

    // Setup authentication
    if (options.apiToken) {
      this.authHeader = `token ${options.apiToken}`;
    } else if (options.username && options.password) {
      const credentials = Buffer.from(
        `${options.username}:${options.password}`,
      ).toString("base64");
      this.authHeader = `Basic ${credentials}`;
    } else {
      throw new CorrelationError(
        "Graylog adapter requires either apiToken or username/password",
        "AUTH_REQUIRED",
      );
    }

    // Create SOCKS proxy agent if configured
    if (this.options.proxy) {
      const { host, port, username, password, type = 5 } = this.options.proxy;
      const auth = username && password ? `${username}:${password}@` : "";
      const proxyUrl = `socks${type}://${auth}${host}:${port}`;
      this.proxyAgent = new SocksProxyAgent(proxyUrl);
    }

    // Resolve stream name to ID if needed
    if (this.options.streamName && !this.options.streamId) {
      this.streamResolutionPromise = this.resolveStreamName();
    }
  }

  /**
   * Resolve stream name to stream ID
   */
  private async resolveStreamName(): Promise<void> {
    try {
      const url = `${this.options.url}/api/streams`;
      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
        agent: this.proxyAgent as any,
      });

      if (!response.ok) {
        console.warn(
          `Failed to fetch streams for name resolution: ${response.statusText}`,
        );
        return;
      }

      const data = await response.json();
      const streams = data.streams || [];

      // Find stream by name (case-insensitive)
      const stream = streams.find(
        (s: any) =>
          s.title?.toLowerCase() === this.options.streamName?.toLowerCase() ||
          s.name?.toLowerCase() === this.options.streamName?.toLowerCase(),
      );

      if (stream) {
        this.resolvedStreamId = stream.id;
        // Only log if we're not being destroyed (prevents "Cannot log after tests are done")
        if (this.activeStreams) {
          // Log success without revealing the stream name
          console.log(`Successfully resolved stream`);
        }
      } else {
        // Only warn if we're not being destroyed
        if (this.activeStreams) {
          // Don't log actual stream names for security reasons
          console.warn(`Stream not found. ${streams.length} streams available`);
        }
      }
    } catch (error) {
      // Only warn if we're not being destroyed
      if (this.activeStreams) {
        console.warn(`Failed to resolve stream name: ${error}`);
      }
    }
  }

  /**
   * Get the effective stream ID (resolved from name or direct ID)
   */
  private async getEffectiveStreamId(): Promise<string | undefined> {
    // Wait for stream name resolution if in progress
    if (this.streamResolutionPromise) {
      await this.streamResolutionPromise;
      this.streamResolutionPromise = undefined; // Clear after resolution
    }

    // Return resolved ID or original streamId
    return this.resolvedStreamId || this.options.streamId;
  }

  getName(): string {
    return "graylog";
  }

  async *createStream(
    query: string,
    options?: unknown,
  ): AsyncIterable<LogEvent> {
    const opts =
      (options as { timeRange?: string; continuous?: boolean }) || {};
    const timeRange = opts.timeRange || "5m";
    const continuous = opts.continuous === true; // Default to false for correlation queries

    if (continuous) {
      // For real-time monitoring, poll continuously
      yield* this.createPollingStream(query, timeRange);
    } else {
      // For correlation queries with time windows, fetch historical data once
      // This aligns with LogQL/PromQL semantics where [5m] means "last 5 minutes of data"
      yield* this.createHistoricalStream(query, timeRange);
    }
  }

  private async *createHistoricalStream(
    query: string,
    timeRange: string,
  ): AsyncIterable<LogEvent> {
    const controller = new AbortController();
    this.activeStreams.add(controller);

    try {
      const timeWindowMs = this.parseTimeRange(timeRange);
      const now = new Date();
      const from = new Date(now.getTime() - timeWindowMs);

      // Get effective stream ID once at the start
      const effectiveStreamId = await this.getEffectiveStreamId();

      const searchParams: Record<string, unknown> = {
        query:
          this.options.apiVersion === "v6"
            ? query
            : this.convertToGraylogQuery(query),
        from: from.toISOString(),
        to: now.toISOString(),
        limit: 1000,
        sort: "timestamp:asc",
        fields: "_id,message,timestamp,source,*",
        range: Math.floor(timeWindowMs / 1000), // Add range in seconds for v6
      };

      if (effectiveStreamId) {
        searchParams["filter"] = `streams:${effectiveStreamId}`;
      }

      const response = await this.search(searchParams, controller.signal);

      if (response.messages && response.messages.length > 0) {
        for (const msg of response.messages) {
          yield this.parseGraylogMessage(msg.message);
        }
      }
    } finally {
      this.activeStreams.delete(controller);
    }
  }

  private async *createPollingStream(
    query: string,
    timeRange: string,
  ): AsyncIterable<LogEvent> {
    const controller = new AbortController();
    this.activeStreams.add(controller);

    try {
      let lastMessageId: string | null = null;
      const timeWindowMs = this.parseTimeRange(timeRange);

      // Get effective stream ID once at the start
      const effectiveStreamId = await this.getEffectiveStreamId();

      while (!controller.signal.aborted) {
        const now = new Date();
        const from = new Date(now.getTime() - timeWindowMs);

        const searchParams: Record<string, unknown> = {
          query:
            this.options.apiVersion === "v6"
              ? query
              : this.convertToGraylogQuery(query),
          from: from.toISOString(),
          to: now.toISOString(),
          limit: 1000,
          sort: "timestamp:asc",
          fields: "_id,message,timestamp,source,*",
          range: Math.floor(timeWindowMs / 1000), // Add range in seconds for v6
        };

        if (effectiveStreamId) {
          searchParams["filter"] = `streams:${effectiveStreamId}`;
        }

        try {
          const response = await this.search(searchParams, controller.signal);

          if (response.messages && response.messages.length > 0) {
            let newMessages = response.messages;

            // Filter out messages we've already seen
            if (lastMessageId) {
              const lastIndex = newMessages.findIndex(
                (m) => m.message._id === lastMessageId,
              );
              if (lastIndex >= 0) {
                newMessages = newMessages.slice(lastIndex + 1);
              }
            }

            for (const msg of newMessages) {
              yield this.parseGraylogMessage(msg.message);
              lastMessageId = msg.message._id;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          console.error("Graylog polling error:", error);

          // Retry with exponential backoff - check for abort signal
          await new Promise((resolve) => {
            if (controller.signal.aborted) return resolve(undefined);

            const timeoutId = setTimeout(
              resolve,
              this.options.pollInterval! * 2,
            );

            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeoutId);
                resolve(undefined);
              },
              { once: true },
            );
          });
        }

        // Break if aborted before the wait period
        if (controller.signal.aborted) break;

        // Wait before next poll - check for abort signal
        await new Promise((resolve) => {
          if (controller.signal.aborted) return resolve(undefined);

          const timeoutId = setTimeout(resolve, this.options.pollInterval);

          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeoutId);
              resolve(undefined);
            },
            { once: true },
          );
        });
      }
    } finally {
      this.activeStreams.delete(controller);
    }
  }

  private async search(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GraylogSearchResponse> {
    if (this.options.apiVersion === "v6") {
      return this.searchViews(params, signal);
    } else {
      return this.searchUniversal(params, signal);
    }
  }

  private async searchUniversal(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GraylogSearchResponse> {
    const url = `${this.options.url}/api/search/universal/relative`;
    const queryParams = new URLSearchParams(params as Record<string, string>);

    const fetchOptions: RequestInit = {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "X-Requested-By": "log-correlator",
      },
      signal,
      agent: this.proxyAgent as any,
    };

    const response = await fetch(`${url}?${queryParams}`, fetchOptions);

    if (!response.ok) {
      throw new CorrelationError(
        `Graylog search failed: ${response.statusText}`,
        "GRAYLOG_SEARCH_ERROR",
        { status: response.status },
      );
    }

    return await response.json();
  }

  private async searchViews(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GraylogSearchResponse> {
    const url = `${this.options.url}/api/views/search/messages`;

    // Calculate time window in seconds for relative timerange
    const range = (params.range as number) || 300; // Default 5 minutes

    // Convert query for Graylog v6 - handle special cases
    let query = (params.query as string) || "";

    // Graylog v6 doesn't allow '*' as first character in WildcardQuery
    // Use empty string for "all messages" queries
    if (query === "*" || query === "") {
      query = "";
    } else {
      // Ensure the query is properly formatted for Graylog v6
      query = this.sanitizeQueryForV6(query);
    }

    // Graylog v6 views API expects this exact structure with nested query_string
    const requestBody: any = {
      query_string: {
        query_string: query,
      },
      timerange: {
        type: "relative",
        from: range, // seconds ago
      },
      // Request more fields to capture all available data
      // Using "*" would be ideal but some Graylog versions don't support it
      // So we request common fields explicitly
      fields_in_order: [
        "timestamp",
        "source",
        "message",
        "_id",
        "level",
        "severity",
        "tier",
        "application",
        "http_status_class",
        "status",
        "http_status",
        "trace_id",
        "request_id",
        "correlation_id",
        "session_id",
        "span_id",
        "host",
        "service",
        "component",
        "module",
        "user",
        "client_ip",
        "method",
        "path",
        "url",
        "response_time",
        "duration",
        "size",
      ],
      limit: (params.limit as number) || 1000,
      chunk_size: 1000,
    };

    // Add streams filter if configured
    const effectiveStreamId = await this.getEffectiveStreamId();
    if (effectiveStreamId) {
      // Validate that streamId looks like a MongoDB ObjectId (24 hex characters)
      if (/^[a-f0-9]{24}$/i.test(effectiveStreamId)) {
        requestBody.streams = [effectiveStreamId];
      } else {
        // Don't log the actual stream ID for security reasons (CodeQL js/clear-text-logging)
        console.warn(
          `Warning: Invalid streamId format - must be 24 hex characters. Ignoring stream filter.`,
        );
      }
    }

    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "text/csv", // v6 API returns CSV by default
        "X-Requested-By": "log-correlator",
      },
      body: JSON.stringify(requestBody),
      signal,
      agent: this.proxyAgent as any,
    };

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      // Try to get error details from response body
      let errorDetails: any = { status: response.status };
      try {
        const errorText = await response.text();
        if (errorText) {
          try {
            errorDetails = JSON.parse(errorText);
          } catch {
            errorDetails.message = errorText;
          }
        }
      } catch {
        // Ignore error reading response body
      }

      throw new CorrelationError(
        `Graylog views search failed: ${response.statusText}`,
        "GRAYLOG_SEARCH_ERROR",
        errorDetails,
      );
    }

    // Parse CSV response (v6 API returns CSV by default)
    const csvText = await response.text();
    return this.parseCSVResponse(csvText);
  }

  private parseCSVResponse(csv: string): GraylogSearchResponse {
    const lines = csv.split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      return {
        messages: [],
        total_results: 0,
        from: new Date().toISOString(),
        to: new Date().toISOString(),
      };
    }

    // Parse CSV header
    const headers = this.parseCSVLine(lines[0]);
    const messages: Array<{ message: GraylogMessage; index: string }> = [];

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (values.length !== headers.length) continue;

      const fields: Record<string, unknown> = {};
      let timestamp = "";
      let message = "";
      let source = "";
      let id = "";

      for (let j = 0; j < headers.length; j++) {
        const header = headers[j].toLowerCase();
        const value = values[j];

        if (header === "timestamp") {
          timestamp = value;
        } else if (header === "message") {
          message = value;
        } else if (header === "source") {
          source = value;
        } else if (header === "_id" || header === "id") {
          id = value;
        } else {
          fields[header] = value;
        }
      }

      messages.push({
        message: {
          _id: id || `msg_${i}`,
          timestamp,
          message,
          source,
          fields,
        },
        index: "graylog",
      });
    }

    return {
      messages,
      total_results: messages.length,
      from: messages[0]?.message.timestamp || new Date().toISOString(),
      to:
        messages[messages.length - 1]?.message.timestamp ||
        new Date().toISOString(),
    };
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        // Field separator
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    // Add last field
    if (current || line.endsWith(",")) {
      result.push(current);
    }

    return result;
  }

  private parseGraylogMessage(message: GraylogMessage): LogEvent {
    // Extract labels from fields
    const labels: Record<string, string> = {};
    const joinKeys: Record<string, string> = {};

    if (message.fields) {
      for (const [key, value] of Object.entries(message.fields)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          labels[key] = String(value);

          // Check if this field could be a join key
          if (
            key.endsWith("_id") ||
            key.includes("correlation") ||
            key.includes("trace")
          ) {
            joinKeys[key] = String(value);
          }
        }
      }
    }

    // Also extract join keys from message content if available
    if (message.message) {
      const extractedKeys = this.extractJoinKeys(message.message);
      Object.assign(joinKeys, extractedKeys);
    }

    return {
      timestamp: message.timestamp || new Date().toISOString(),
      source: "graylog",
      stream: message.source || "unknown",
      message: message.message || "",
      labels,
      joinKeys,
    };
  }

  private extractJoinKeys(message: string): Record<string, string> {
    const keys: Record<string, string> = {};

    // Common patterns for extracting IDs
    const patterns = [
      /request[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /trace[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /session[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
      /correlation[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
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

  private sanitizeQueryForV6(query: string): string {
    // Graylog v6 has stricter query parsing rules
    // Handle common patterns that cause issues

    // Remove leading/trailing whitespace
    query = query.trim();

    // If query is just a wildcard, return empty (search all)
    if (query === "*") {
      return "";
    }

    // If query starts with standalone wildcard, remove it (not allowed in v6)
    if (query.startsWith("* ")) {
      query = query.substring(2).trim();
    }

    // Handle empty field queries (e.g., "field:" without value)
    // These cause parse errors in v6
    // But don't match field:* which is valid
    // Use a non-vulnerable regex pattern to avoid ReDoS
    query = query.replace(/(\w+):\s(?=\s|$|AND|OR)/g, "$1:*");

    // Handle quoted empty values - remove them entirely
    // Use simpler regex to avoid ReDoS vulnerability
    query = query.replace(/(\w+):""/g, "");
    query = query.replace(/(\w+):''/g, "");

    // Handle invalid patterns like ":value" (colon without field name)
    query = query.replace(/^\s*:\w+/g, "");
    query = query.replace(/\s+:\w+/g, "");

    // Clean up multiple spaces and trim
    query = query.replace(/\s+/g, " ").trim();

    // If query becomes empty after sanitization, return empty string
    if (!query || query === "AND" || query === "OR") {
      return "";
    }

    return query;
  }

  private convertToGraylogQuery(query: string): string {
    // Convert from simplified syntax to Graylog query
    // Example: service:backend -> service:backend
    // Example: service="backend" -> service:backend

    // Parse without regex to avoid ReDoS vulnerabilities
    let result = "";
    let i = 0;

    while (i < query.length) {
      // Look for field="value" or field='value' patterns
      const fieldStart = i;
      // Check for word characters without regex
      while (
        i < query.length &&
        ((query[i] >= "a" && query[i] <= "z") ||
          (query[i] >= "A" && query[i] <= "Z") ||
          (query[i] >= "0" && query[i] <= "9") ||
          query[i] === "_")
      ) {
        i++;
      }

      if (i > fieldStart && i < query.length && query[i] === "=") {
        const field = query.substring(fieldStart, i);
        i++; // skip '='

        if (i < query.length && (query[i] === '"' || query[i] === "'")) {
          const quote = query[i];
          i++; // skip opening quote
          const valueStart = i;

          // Find closing quote
          while (i < query.length && query[i] !== quote) {
            i++;
          }

          if (i < query.length) {
            const value = query.substring(valueStart, i);
            result += field + ":" + value;
            i++; // skip closing quote
          } else {
            // No closing quote, treat as literal
            result += query.substring(fieldStart);
            break;
          }
        } else {
          // No quotes after =, revert to original
          result += query.substring(fieldStart, i);
        }
      } else {
        // Not a field=value pattern, copy as-is
        if (fieldStart < i) {
          result += query.substring(fieldStart, i);
        }
        if (i < query.length) {
          result += query[i];
          i++;
        }
      }
    }

    // Handle AND/OR operators
    const words: string[] = [];
    let currentWord = "";

    for (let j = 0; j < result.length; j++) {
      if (
        result[j] === " " ||
        result[j] === "\t" ||
        result[j] === "\n" ||
        result[j] === "\r"
      ) {
        if (currentWord) {
          const upperWord = currentWord.toUpperCase();
          words.push(
            upperWord === "AND" || upperWord === "OR" ? upperWord : currentWord,
          );
          currentWord = "";
        }
      } else {
        currentWord += result[j];
      }
    }
    if (currentWord) {
      const upperWord = currentWord.toUpperCase();
      words.push(
        upperWord === "AND" || upperWord === "OR" ? upperWord : currentWord,
      );
    }

    result = words.join(" ");

    return result;
  }

  private parseTimeRange(timeRange: string): number {
    const match = timeRange.match(/^(\d+)([smhd])$/);
    if (!match) {
      // Default to 5 minutes
      return 5 * 60 * 1000;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      default:
        return 5 * 60 * 1000;
    }
  }

  validateQuery(query: string): boolean {
    // Basic validation for Graylog query syntax
    try {
      // Limit query length to prevent DoS
      if (!query || query.length > 10000) {
        return false;
      }

      // Check for basic field:value syntax
      if (query.includes(":") || query.includes("=")) {
        return true;
      }

      // Allow simple text searches
      if (query.length > 0) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async getAvailableStreams(): Promise<string[]> {
    const url = `${this.options.url}/api/streams`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "X-Requested-By": "log-correlator",
        },
        agent: this.proxyAgent as any,
      });

      if (!response.ok) {
        throw new CorrelationError(
          "Failed to fetch available streams",
          "GRAYLOG_STREAMS_ERROR",
        );
      }

      const data = await response.json();
      return data.streams?.map((s: { title: string }) => s.title) || [];
    } catch (error) {
      console.error("Failed to get available streams:", error);
      return [];
    }
  }

  async destroy(): Promise<void> {
    // Cancel all active polling streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();

    // Wait for stream resolution to complete if in progress
    // This prevents the "Cannot log after tests are done" error
    if (this.streamResolutionPromise) {
      try {
        await this.streamResolutionPromise;
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.streamResolutionPromise = undefined;
    }
  }
}
