/**
 * Prometheus Integration Test Configuration
 *
 * This file contains configuration for running integration tests against a live Prometheus instance.
 * Copy this file to prometheus.config.local.js and update with your Prometheus instance details.
 *
 * The local config file is gitignored to prevent committing sensitive information.
 *
 * Environment variables are used for sensitive data to avoid hardcoding credentials.
 * Set these environment variables before running integration tests:
 *
 * - PROMETHEUS_URL: The URL of your Prometheus instance
 * - PROMETHEUS_USERNAME: Username for basic auth (optional)
 * - PROMETHEUS_PASSWORD: Password for basic auth (optional)
 * - PROMETHEUS_API_TOKEN: Bearer token for authentication (optional)
 * - PROMETHEUS_STEP: Query resolution step (optional, e.g., "15s", "1m")
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
    // Prometheus server URL (required)
    url: process.env.PROMETHEUS_URL,

    // Authentication (optional)
    username: process.env.PROMETHEUS_USERNAME,
    password: process.env.PROMETHEUS_PASSWORD,
    apiToken: process.env.PROMETHEUS_API_TOKEN,

    // Query settings
    step: process.env.PROMETHEUS_STEP || "15s", // Query resolution
    pollInterval: parseInt(process.env.PROMETHEUS_POLL_INTERVAL) || 0, // 0 = instant queries
    timeout: parseInt(process.env.PROMETHEUS_TIMEOUT) || 30000,
    maxRetries: parseInt(process.env.PROMETHEUS_MAX_RETRIES) || 3,
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
    // Skip integration tests if no Prometheus URL is configured
    skipIfNoConnection: !process.env.PROMETHEUS_URL,

    // Maximum time to wait for results (ms)
    maxWaitTime: parseInt(process.env.PROMETHEUS_TEST_TIMEOUT) || 15000,

    // Maximum number of data points to collect per test
    maxEventsPerTest: parseInt(process.env.PROMETHEUS_MAX_EVENTS) || 50,

    // Enable verbose logging
    verbose: process.env.PROMETHEUS_TEST_VERBOSE === "true",
  },

  // Example queries - customize these for your Prometheus instance
  // These queries should match actual metrics in your Prometheus instance
  queries: {
    // Simple metric queries
    simple: {
      // Basic metric (should exist in most Prometheus setups)
      basicMetric: process.env.PROMETHEUS_QUERY_BASIC || "up",

      // Counter metric
      counter:
        process.env.PROMETHEUS_QUERY_COUNTER ||
        "prometheus_notifications_total",

      // Gauge metric
      gauge:
        process.env.PROMETHEUS_QUERY_GAUGE ||
        "prometheus_config_last_reload_successful",

      // Histogram metric
      histogram:
        process.env.PROMETHEUS_QUERY_HISTOGRAM ||
        "prometheus_http_request_duration_seconds_bucket",
    },

    // Function-based queries
    functions: {
      // Rate function
      rate:
        process.env.PROMETHEUS_QUERY_RATE ||
        "rate(prometheus_notifications_total[5m])",

      // Aggregation function
      aggregation: process.env.PROMETHEUS_QUERY_AGG || "sum(up)",

      // Binary operators
      binaryOps: process.env.PROMETHEUS_QUERY_BINARY || "up * 100",
    },

    // Complex queries
    complex: {
      // Label selector
      labelSelector:
        process.env.PROMETHEUS_QUERY_LABELS || 'up{job="prometheus"}',

      // Multiple label selectors
      multiLabel:
        process.env.PROMETHEUS_QUERY_MULTI ||
        'prometheus_notifications_total{instance=~".*",job="prometheus"}',

      // Range query with function
      rangeFunction:
        process.env.PROMETHEUS_QUERY_RANGE ||
        "increase(prometheus_notifications_total[1h])",
    },

    // Correlation queries (for testing correlation features)
    correlation: {
      // Query that should have correlation ID fields
      withCorrelationId:
        process.env.PROMETHEUS_QUERY_CORRELATION || 'up{job=~".*"}',

      // Field to use for correlation
      correlationField: process.env.PROMETHEUS_CORRELATION_FIELD || "instance",
    },

    // Time ranges for queries
    timeRanges: {
      short: "5m", // Last 5 minutes
      medium: "30m", // Last 30 minutes
      long: "2h", // Last 2 hours
      veryLong: "24h", // Last 24 hours
    },
  },

  // Field mappings - customize based on your Prometheus setup
  fieldMappings: {
    // Common Prometheus fields
    instance: process.env.PROMETHEUS_FIELD_INSTANCE || "instance",
    job: process.env.PROMETHEUS_FIELD_JOB || "job",
    metricName: process.env.PROMETHEUS_FIELD_METRIC || "__name__",

    // Correlation ID fields (customize based on your setup)
    requestId: process.env.PROMETHEUS_FIELD_REQUEST_ID || "request_id",
    traceId: process.env.PROMETHEUS_FIELD_TRACE_ID || "trace_id",
    spanId: process.env.PROMETHEUS_FIELD_SPAN_ID || "span_id",
    correlationId:
      process.env.PROMETHEUS_FIELD_CORRELATION_ID || "correlation_id",
  },

  // Expected test results - helps validate tests are working
  expectations: {
    // Minimum number of results expected for basic queries
    minBasicMetrics: parseInt(process.env.PROMETHEUS_MIN_BASIC) || 0,
    minCounterMetrics: parseInt(process.env.PROMETHEUS_MIN_COUNTER) || 0,
    minGaugeMetrics: parseInt(process.env.PROMETHEUS_MIN_GAUGE) || 0,

    // Expected labels in metrics (customize based on your setup)
    expectedLabels: (
      process.env.PROMETHEUS_EXPECTED_LABELS || "instance,job"
    ).split(","),

    // Fields that might contain correlation IDs
    correlationFields: (
      process.env.PROMETHEUS_CORRELATION_FIELDS ||
      "instance,job,request_id,trace_id"
    ).split(","),
  },

  // Debug settings
  debug: {
    // Log raw Prometheus responses
    logRawResponses: process.env.PROMETHEUS_DEBUG_RAW === "true",

    // Log query transformations
    logQueryTransform: process.env.PROMETHEUS_DEBUG_QUERIES === "true",

    // Save test results to file
    saveResults: process.env.PROMETHEUS_SAVE_RESULTS === "true",
    resultsPath: process.env.PROMETHEUS_RESULTS_PATH || "./test-results",
  },
};
