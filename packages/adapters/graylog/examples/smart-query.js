#!/usr/bin/env node

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TimeBridgeEngine } = require("@timebridge/core");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraylogAdapter } = require("../dist/graylog-adapter");

/**
 * Detects if a query is a correlation query or a direct query
 * Correlation queries have join operators: and on(), or on(), unless on()
 * Direct queries are single source queries like: graylog(query)[timerange]
 */
function isCorrelationQuery(query) {
  // Check for correlation operators
  const correlationPatterns = [
    /\s+and\s+on\s*\(/i,
    /\s+or\s+on\s*\(/i,
    /\s+unless\s+on\s*\(/i,
    /\s+within\s*\(/i,
  ];

  return correlationPatterns.some((pattern) => pattern.test(query));
}

/**
 * Extracts query and time range from a direct query
 * Example: graylog(level:error)[5m] -> {query: "level:error", timeRange: "5m"}
 */
function parseDirectQuery(queryString) {
  const match = queryString.match(/^graylog\((.*?)\)\[([^\]]+)\]$/);
  if (!match) {
    throw new Error(
      "Invalid query format. Expected: graylog(query)[timeRange]"
    );
  }
  return {
    query: match[1],
    timeRange: match[2],
  };
}

/**
 * Creates a Graylog adapter with the given configuration
 */
function createGraylogAdapter(config) {
  const adapterConfig = {
    url: config.url,
    apiVersion: config.apiVersion || "v6",
    pollInterval: config.pollInterval || 2000,
    timeout: config.timeout || 15000,
  };

  // Add authentication
  if (config.apiToken) {
    adapterConfig.apiToken = config.apiToken;
  } else if (config.username && config.password) {
    adapterConfig.username = config.username;
    adapterConfig.password = config.password;
  }

  // Add stream filtering
  if (config.streamName) {
    adapterConfig.streamName = config.streamName;
  } else if (config.streamId) {
    adapterConfig.streamId = config.streamId;
  }

  // Add proxy configuration
  if (config.proxy) {
    adapterConfig.proxy = config.proxy;
  }

  return new GraylogAdapter(adapterConfig);
}

/**
 * Executes a direct query using the Graylog adapter
 */
async function executeDirect(adapter, queryString, options = {}) {
  const { query, timeRange } = parseDirectQuery(queryString);

  console.log("📊 Executing direct query:");
  console.log(`   Query: ${query}`);
  console.log(`   Time range: ${timeRange}`);
  console.log("");

  const stream = adapter.createStream(query, timeRange);
  const events = [];
  const maxEvents = options.maxEvents || 100;

  for await (const event of stream) {
    events.push(event);

    if (options.onEvent) {
      options.onEvent(event);
    }

    if (events.length >= maxEvents) {
      console.log(`⚠️  Reached maximum event limit (${maxEvents})`);
      break;
    }
  }

  return events;
}

/**
 * Executes a correlation query using the correlation engine
 */
async function executeCorrelation(engine, queryString, options = {}) {
  console.log("🔗 Executing correlation query:");
  console.log(`   Query: ${queryString}`);
  console.log("");

  const correlations = [];
  const maxCorrelations = options.maxCorrelations || 100;

  for await (const correlation of engine.correlate(queryString)) {
    correlations.push(correlation);

    if (options.onCorrelation) {
      options.onCorrelation(correlation);
    }

    if (correlations.length >= maxCorrelations) {
      console.log(`⚠️  Reached maximum correlation limit (${maxCorrelations})`);
      break;
    }
  }

  return correlations;
}

/**
 * Smart query executor that auto-detects query type
 */
class SmartQueryExecutor {
  constructor(config) {
    this.config = config;
    this.adapter = createGraylogAdapter(config);
    this.engine = null;
  }

  /**
   * Executes a query, automatically detecting if it's a correlation or direct query
   */
  async execute(queryString, options = {}) {
    const isCorrelation = isCorrelationQuery(queryString);

    console.log(`🔍 Query type: ${isCorrelation ? "Correlation" : "Direct"}`);

    if (isCorrelation) {
      // Create correlation engine if not already created
      if (!this.engine) {
        this.engine = new TimeBridgeEngine({
          timeWindow: this.config.timeWindow || 30000,
          maxEvents: this.config.maxEvents || 10000,
        });
        this.engine.addAdapter("graylog", this.adapter);
      }
      return await executeCorrelation(this.engine, queryString, options);
    } else {
      return await executeDirect(this.adapter, queryString, options);
    }
  }

  /**
   * Validates a query without executing it
   */
  validateQuery(queryString) {
    try {
      if (isCorrelationQuery(queryString)) {
        // For correlation queries, we'd need the parser to validate
        // For now, just check basic structure
        return { valid: true, type: "correlation" };
      } else {
        // Try to parse direct query
        parseDirectQuery(queryString);
        return { valid: true, type: "direct" };
      }
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

// Export for use as a module
module.exports = { SmartQueryExecutor, isCorrelationQuery, parseDirectQuery };

// Example usage when run directly
async function demo() {
  // Example configuration
  const config = {
    url: process.env.GRAYLOG_URL || "http://localhost:9000",
    username: process.env.GRAYLOG_USERNAME || "admin",
    password: process.env.GRAYLOG_PASSWORD || "admin",
    apiVersion: process.env.GRAYLOG_API_VERSION || "v6",
    streamName: process.env.GRAYLOG_STREAM_NAME,
    proxy: process.env.SOCKS_PROXY_HOST
      ? {
          host: process.env.SOCKS_PROXY_HOST,
          port: parseInt(process.env.SOCKS_PROXY_PORT || "1080"),
          type: 5,
        }
      : undefined,
  };

  const executor = new SmartQueryExecutor(config);

  // Example queries
  const queries = [
    // Direct query
    "graylog(level:error)[5m]",

    // Correlation query
    "graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]",
  ];

  for (const query of queries) {
    console.log("\n" + "=".repeat(60));
    console.log(`Testing query: ${query}`);
    console.log("=".repeat(60) + "\n");

    // Validate first
    const validation = executor.validateQuery(query);
    console.log(
      `✅ Validation: ${validation.valid ? "Valid" : "Invalid"} (${
        validation.type || validation.error
      })`
    );

    if (validation.valid) {
      try {
        const results = await executor.execute(query, {
          maxEvents: 10,
          maxCorrelations: 10,
          onEvent: (event) => {
            console.log(
              `  📝 Event: ${event.timestamp} - ${event.message?.substring(
                0,
                50
              )}...`
            );
          },
          onCorrelation: (correlation) => {
            console.log(
              `  🔗 Correlation found with ${correlation.events.length} events`
            );
          },
        });

        console.log(
          `\n📊 Results: ${results.length} ${
            validation.type === "correlation" ? "correlations" : "events"
          } found`
        );
      } catch (error) {
        console.error(`❌ Execution error: ${error.message}`);
      }
    }
  }
}

// Run demo if called directly
if (require.main === module) {
  demo().catch(console.error);
}
