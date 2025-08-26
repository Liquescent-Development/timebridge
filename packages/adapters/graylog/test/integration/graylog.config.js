/**
 * Graylog Integration Test Configuration
 *
 * This file contains configuration for running integration tests against a live Graylog instance.
 * Copy this file to graylog.config.local.js and update with your Graylog instance details.
 *
 * The local config file is gitignored to prevent committing sensitive information.
 *
 * Environment variables are used for sensitive data to avoid hardcoding credentials.
 * Set these environment variables before running integration tests:
 *
 * - GRAYLOG_URL: The URL of your Graylog instance
 * - GRAYLOG_USERNAME: Username for basic auth (optional if using API token)
 * - GRAYLOG_PASSWORD: Password for basic auth (optional if using API token)
 * - GRAYLOG_API_TOKEN: API token for authentication (optional if using basic auth)
 * - GRAYLOG_STREAM_NAME: Name of the stream to filter (optional)
 * - GRAYLOG_STREAM_ID: ID of the stream to filter (optional, takes precedence over name)
 *
 * For SOCKS proxy support:
 * - SOCKS_PROXY_HOST: SOCKS proxy hostname
 * - SOCKS_PROXY_PORT: SOCKS proxy port
 * - SOCKS_PROXY_TYPE: 4 or 5 (defaults to 5)
 * - SOCKS_PROXY_USERNAME: Proxy username (optional)
 * - SOCKS_PROXY_PASSWORD: Proxy password (optional)
 */

module.exports = {
  // Connection settings
  connection: {
    // Graylog server URL (required)
    url: process.env.GRAYLOG_URL,

    // API version: 'legacy' (2.x-5.x) or 'v6' (6.x+)
    apiVersion: process.env.GRAYLOG_API_VERSION || "v6",

    // Authentication (use either basic auth or API token)
    username: process.env.GRAYLOG_USERNAME,
    password: process.env.GRAYLOG_PASSWORD,
    apiToken: process.env.GRAYLOG_API_TOKEN,

    // Stream filtering (optional)
    streamName: process.env.GRAYLOG_STREAM_NAME, // e.g., "Application Logs"
    streamId: process.env.GRAYLOG_STREAM_ID, // e.g., "507f1f77bcf86cd799439011"

    // Polling settings
    pollInterval: parseInt(process.env.GRAYLOG_POLL_INTERVAL) || 2000,
    timeout: parseInt(process.env.GRAYLOG_TIMEOUT) || 15000,
    maxRetries: parseInt(process.env.GRAYLOG_MAX_RETRIES) || 3,
  },

  // SOCKS proxy configuration (optional)
  proxy: process.env.SOCKS_PROXY_HOST
    ? {
        host: process.env.SOCKS_PROXY_HOST,
        port: parseInt(process.env.SOCKS_PROXY_PORT) || 1080,
        type: parseInt(process.env.SOCKS_PROXY_TYPE) || 5,
        username: process.env.SOCKS_PROXY_USERNAME,
        password: process.env.SOCKS_PROXY_PASSWORD,
      }
    : null,

  // Test configuration
  testConfig: {
    // Skip integration tests if no Graylog URL is configured
    skipIfNoConnection: !process.env.GRAYLOG_URL,

    // Maximum time to wait for results (ms) - reduced from 60s to 30s for faster test failures
    maxWaitTime: parseInt(process.env.GRAYLOG_TEST_TIMEOUT) || 30000,

    // Maximum number of events to collect per test
    maxEventsPerTest: parseInt(process.env.GRAYLOG_MAX_EVENTS) || 100,

    // Enable verbose logging
    verbose: process.env.GRAYLOG_TEST_VERBOSE === "true",
  },

  // Example queries - customize these for your Graylog instance
  // These queries should match actual data in your Graylog instance
  queries: {
    // Simple queries
    simple: {
      // Find all error messages
      errorLogs:
        process.env.GRAYLOG_QUERY_ERRORS || "level:error OR level:ERROR",

      // Find all warning messages
      warningLogs:
        process.env.GRAYLOG_QUERY_WARNINGS ||
        "level:warn OR level:WARN OR level:warning",

      // Find all info messages
      infoLogs: process.env.GRAYLOG_QUERY_INFO || "level:info OR level:INFO",

      // Find messages from a specific source/service
      serviceSpecific:
        process.env.GRAYLOG_QUERY_SERVICE || "source:nginx OR source:apache",

      // Find all messages (use with caution)
      allLogs: "*",
    },

    // Complex queries with field combinations
    complex: {
      // Service + level combination
      serviceErrors:
        process.env.GRAYLOG_QUERY_SERVICE_ERRORS ||
        "source:nginx AND level:error",

      // Multiple field query
      multiField:
        process.env.GRAYLOG_QUERY_MULTI || "level:error AND source:application",

      // Query with HTTP status codes
      httpErrors: process.env.GRAYLOG_QUERY_HTTP || "status:[500 TO 599]",

      // Query with response time
      slowRequests: process.env.GRAYLOG_QUERY_SLOW || "response_time:>1000",
    },

    // Correlation queries (for testing correlation features)
    correlation: {
      // Field to use for correlation (e.g., request_id, trace_id, correlation_id)
      correlationField: process.env.GRAYLOG_CORRELATION_FIELD || "request_id",

      // Specific correlation ID to search for (if you know one exists)
      specificCorrelationId: process.env.GRAYLOG_CORRELATION_ID,

      // Query to find messages with correlation IDs
      withCorrelationId:
        process.env.GRAYLOG_QUERY_CORRELATION || "request_id:*",
    },

    // Time-based queries
    timeRanges: {
      // Different time windows to test
      short: "1m", // Last 1 minute
      medium: "5m", // Last 5 minutes
      long: "30m", // Last 30 minutes
      veryLong: "1h", // Last 1 hour
    },
  },

  // Field mappings - customize based on your Graylog field names
  fieldMappings: {
    // Map common field names to your Graylog field names
    timestamp: process.env.GRAYLOG_FIELD_TIMESTAMP || "timestamp",
    message: process.env.GRAYLOG_FIELD_MESSAGE || "message",
    level: process.env.GRAYLOG_FIELD_LEVEL || "level",
    source: process.env.GRAYLOG_FIELD_SOURCE || "source",
    host: process.env.GRAYLOG_FIELD_HOST || "host",

    // Correlation ID fields (customize based on your setup)
    requestId: process.env.GRAYLOG_FIELD_REQUEST_ID || "request_id",
    traceId: process.env.GRAYLOG_FIELD_TRACE_ID || "trace_id",
    sessionId: process.env.GRAYLOG_FIELD_SESSION_ID || "session_id",
    correlationId: process.env.GRAYLOG_FIELD_CORRELATION_ID || "correlation_id",
  },

  // Expected test results - helps validate tests are working
  expectations: {
    // Minimum number of results expected for basic queries
    // Set to 0 if you're not sure, tests will warn but not fail
    minErrorLogs: parseInt(process.env.GRAYLOG_MIN_ERRORS) || 0,
    minWarningLogs: parseInt(process.env.GRAYLOG_MIN_WARNINGS) || 0,
    minInfoLogs: parseInt(process.env.GRAYLOG_MIN_INFO) || 0,

    // Expected fields in messages (customize based on your data)
    expectedFields: (
      process.env.GRAYLOG_EXPECTED_FIELDS || "timestamp,message,source"
    ).split(","),

    // Fields that might contain correlation IDs
    correlationFields: (
      process.env.GRAYLOG_CORRELATION_FIELDS ||
      "request_id,trace_id,correlation_id,session_id"
    ).split(","),
  },

  // Debug settings
  debug: {
    // Log raw Graylog responses
    logRawResponses: process.env.GRAYLOG_DEBUG_RAW === "true",

    // Log query transformations
    logQueryTransform: process.env.GRAYLOG_DEBUG_QUERIES === "true",

    // Log stream resolution
    logStreamResolution: process.env.GRAYLOG_DEBUG_STREAMS === "true",

    // Save test results to file
    saveResults: process.env.GRAYLOG_SAVE_RESULTS === "true",
    resultsPath: process.env.GRAYLOG_RESULTS_PATH || "./test-results",
  },
};
