"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraylogAdapter = void 0;
const log_correlator_core_1 = require("@liquescent/log-correlator-core");
const node_fetch_1 = __importDefault(require("node-fetch"));
class GraylogAdapter {
  constructor(options) {
    this.options = options;
    this.activeStreams = new Set();
    this.options = {
      pollInterval: 2000,
      timeout: 15000,
      maxRetries: 3,
      ...options,
    };
    // Setup authentication
    if (options.apiToken) {
      this.authHeader = `token ${options.apiToken}`;
    } else if (options.username && options.password) {
      const credentials = Buffer.from(
        `${options.username}:${options.password}`
      ).toString("base64");
      this.authHeader = `Basic ${credentials}`;
    } else {
      throw new log_correlator_core_1.CorrelationError(
        "Graylog adapter requires either apiToken or username/password",
        "AUTH_REQUIRED"
      );
    }
  }
  getName() {
    return "graylog";
  }
  async *createStream(query, options) {
    const timeRange = options?.timeRange || "5m";
    yield* this.createPollingStream(query, timeRange);
  }
  async *createPollingStream(query, timeRange) {
    const controller = new AbortController();
    this.activeStreams.add(controller);
    try {
      let lastMessageId = null;
      const timeWindowMs = this.parseTimeRange(timeRange);
      while (!controller.signal.aborted) {
        const now = new Date();
        const from = new Date(now.getTime() - timeWindowMs);
        const searchParams = {
          query: this.convertToGraylogQuery(query),
          from: from.toISOString(),
          to: now.toISOString(),
          limit: 1000,
          sort: "timestamp:asc",
          fields: "_id,message,timestamp,source,*",
        };
        if (this.options.streamId) {
          searchParams["filter"] = `streams:${this.options.streamId}`;
        }
        try {
          const response = await this.search(searchParams, controller.signal);
          if (response.messages && response.messages.length > 0) {
            let newMessages = response.messages;
            // Filter out messages we've already seen
            if (lastMessageId) {
              const lastIndex = newMessages.findIndex(
                (m) => m.message._id === lastMessageId
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
          // Retry with exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.pollInterval * 2)
          );
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
  async search(params, signal) {
    const url = `${this.options.url}/api/search/universal/relative`;
    const queryParams = new URLSearchParams(params);
    const fetchOptions = {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "X-Requested-By": "log-correlator",
      },
      signal,
    };
    const response = await (0, node_fetch_1.default)(
      `${url}?${queryParams}`,
      fetchOptions
    );
    if (!response.ok) {
      throw new log_correlator_core_1.CorrelationError(
        `Graylog search failed: ${response.statusText}`,
        "GRAYLOG_SEARCH_ERROR",
        { status: response.status }
      );
    }
    return await response.json();
  }
  parseGraylogMessage(message) {
    // Extract labels from fields
    const labels = {};
    const joinKeys = {};
    for (const [key, value] of Object.entries(message.fields)) {
      if (typeof value === "string" || typeof value === "number") {
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
    // Also extract join keys from message content
    const extractedKeys = this.extractJoinKeys(message.message);
    Object.assign(joinKeys, extractedKeys);
    return {
      timestamp: message.timestamp,
      source: "graylog",
      stream: message.source || "unknown",
      message: message.message,
      labels,
      joinKeys,
    };
  }
  extractJoinKeys(message) {
    const keys = {};
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
  convertToGraylogQuery(query) {
    // Convert from simplified syntax to Graylog query
    // Example: service:backend -> service:backend
    // Example: service="backend" -> service:backend
    let graylogQuery = query;
    // Replace PromQL-style label matchers with Graylog syntax
    graylogQuery = graylogQuery.replace(/(\w+)="([^"]+)"/g, "$1:$2");
    graylogQuery = graylogQuery.replace(/(\w+)='([^']+)'/g, "$1:$2");
    // Handle AND/OR operators
    graylogQuery = graylogQuery.replace(/\s+AND\s+/gi, " AND ");
    graylogQuery = graylogQuery.replace(/\s+OR\s+/gi, " OR ");
    return graylogQuery;
  }
  parseTimeRange(timeRange) {
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
  validateQuery(query) {
    // Basic validation for Graylog query syntax
    try {
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
  async getAvailableStreams() {
    const url = `${this.options.url}/api/streams`;
    try {
      const response = await (0, node_fetch_1.default)(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "X-Requested-By": "log-correlator",
        },
      });
      if (!response.ok) {
        throw new log_correlator_core_1.CorrelationError(
          "Failed to fetch available streams",
          "GRAYLOG_STREAMS_ERROR"
        );
      }
      const data = await response.json();
      return data.streams?.map((s) => s.title) || [];
    } catch (error) {
      console.error("Failed to get available streams:", error);
      return [];
    }
  }
  async destroy() {
    // Cancel all active polling streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();
  }
}
exports.GraylogAdapter = GraylogAdapter;
//# sourceMappingURL=graylog-adapter.js.map
