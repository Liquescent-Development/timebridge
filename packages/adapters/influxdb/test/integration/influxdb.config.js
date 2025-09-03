/**
 * InfluxDB Integration Test Configuration
 *
 * This file contains configuration for running integration tests against live InfluxDB instances.
 * Copy this file to influxdb.config.local.js and update with your InfluxDB instance details.
 *
 * The local config file is gitignored to prevent committing sensitive information.
 *
 * Environment variables are used for sensitive data to avoid hardcoding credentials.
 * Set these environment variables before running integration tests:
 *
 * Common variables:
 * - INFLUXDB_URL: The URL of your InfluxDB instance
 * - INFLUXDB_VERSION: "1.x" or "2.x" (default: "1.x")
 * - INFLUXDB_PRECISION: Time precision (ns|u|ms|s|m|h, default: "ms")
 *
 * For InfluxDB 1.x:
 * - INFLUXDB_DATABASE: Database name (required for 1.x)
 * - INFLUXDB_USERNAME: Username for basic auth (optional)
 * - INFLUXDB_PASSWORD: Password for basic auth (optional)
 *
 * For InfluxDB 2.x:
 * - INFLUXDB_TOKEN: Authentication token (required for 2.x)
 * - INFLUXDB_ORG: Organization name (required for 2.x)
 * - INFLUXDB_BUCKET: Bucket name (required for 2.x)
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
    // InfluxDB server URL (required)
    url: process.env.INFLUXDB_URL,

    // InfluxDB version: "1.x" or "2.x"
    version: process.env.INFLUXDB_VERSION || "1.x",

    // Time precision for queries
    precision: process.env.INFLUXDB_PRECISION || "ms",

    // InfluxDB 1.x settings
    database: process.env.INFLUXDB_DATABASE,
    username: process.env.INFLUXDB_USERNAME,
    password: process.env.INFLUXDB_PASSWORD,

    // InfluxDB 2.x settings
    token: process.env.INFLUXDB_TOKEN,
    org: process.env.INFLUXDB_ORG,
    bucket: process.env.INFLUXDB_BUCKET,

    // Connection settings
    pollInterval: parseInt(process.env.INFLUXDB_POLL_INTERVAL) || 0, // 0 = one-time queries
    timeout: parseInt(process.env.INFLUXDB_TIMEOUT) || 30000,
    maxRetries: parseInt(process.env.INFLUXDB_MAX_RETRIES) || 3,
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
    // Skip integration tests if no InfluxDB URL is configured
    skipIfNoConnection: !process.env.INFLUXDB_URL,

    // Maximum time to wait for results (ms)
    maxWaitTime: parseInt(process.env.INFLUXDB_TEST_TIMEOUT) || 20000,

    // Maximum number of data points to collect per test
    maxEventsPerTest: parseInt(process.env.INFLUXDB_MAX_EVENTS) || 100,

    // Enable verbose logging
    verbose: process.env.INFLUXDB_TEST_VERBOSE === "true",
  },

  // Example queries - customize these for your InfluxDB instance
  // These queries should match actual data in your InfluxDB instance
  queries: {
    // Simple queries
    simple: {
      // Basic query (customize for your data)
      basicQuery:
        process.env.INFLUXDB_QUERY_BASIC ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -5m)`
          : "SELECT * FROM measurement LIMIT 10"),

      // Time series data
      timeSeries:
        process.env.INFLUXDB_QUERY_TIMESERIES ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -1h) |> sort(columns: ["_time"])`
          : "SELECT time, value FROM temperature ORDER BY time DESC LIMIT 50"),

      // Field selection
      fieldSelection:
        process.env.INFLUXDB_QUERY_FIELDS ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -30m) |> filter(fn: (r) => r._field == "value")`
          : "SELECT temperature, humidity FROM sensors LIMIT 20"),
    },

    // Function-based queries
    functions: {
      // Aggregation functions
      aggregation:
        process.env.INFLUXDB_QUERY_AGG ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -1h) |> mean()`
          : "SELECT MEAN(value) FROM measurement WHERE time > now() - 1h GROUP BY time(10m)"),

      // Mathematical operations
      mathematical:
        process.env.INFLUXDB_QUERY_MATH ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -30m) |> map(fn: (r) => ({r with _value: r._value * 2}))`
          : "SELECT value * 2 FROM measurement WHERE time > now() - 30m LIMIT 10"),
    },

    // Complex queries
    complex: {
      // WHERE clauses
      whereClause:
        process.env.INFLUXDB_QUERY_WHERE ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -1h) |> filter(fn: (r) => r._value > 10.0)`
          : "SELECT * FROM measurement WHERE value > 10 AND time > now() - 1h"),

      // GROUP BY operations
      groupBy:
        process.env.INFLUXDB_QUERY_GROUP ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -2h) |> group(columns: ["host"]) |> mean()`
          : "SELECT MEAN(value) FROM measurement WHERE time > now() - 2h GROUP BY host"),

      // Field and tag information
      fieldAndTags:
        process.env.INFLUXDB_QUERY_TAGS ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -30m) |> keep(columns: ["_time", "_field", "_value", "host", "region"])`
          : "SELECT * FROM measurement WHERE time > now() - 30m LIMIT 10"),
    },

    // Version-specific queries
    v1: {
      // InfluxQL-specific functions
      influxqlFunction:
        process.env.INFLUXDB_V1_FUNCTION ||
        "SELECT DERIVATIVE(mean(value)) FROM measurement WHERE time > now() - 1h GROUP BY time(10m)",

      // Continuous query results
      continuousQuery:
        process.env.INFLUXDB_V1_CQ ||
        "SELECT * FROM cq_result WHERE time > now() - 1h LIMIT 20",
    },

    v2: {
      // Flux transformations
      fluxTransform:
        process.env.INFLUXDB_V2_TRANSFORM ||
        `from(bucket: "${
          process.env.INFLUXDB_BUCKET || "test"
        }") |> range(start: -30m) |> filter(fn: (r) => r._measurement == "temperature") |> map(fn: (r) => ({r with celsius: (r._value - 32.0) * 5.0 / 9.0}))`,

      // Flux filters
      fluxFilter:
        process.env.INFLUXDB_V2_FILTER ||
        `from(bucket: "${
          process.env.INFLUXDB_BUCKET || "test"
        }") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "cpu" and r.host == "server01")`,
    },

    // Correlation queries (for testing correlation features)
    correlation: {
      // Query with correlation ID fields
      withCorrelationId:
        process.env.INFLUXDB_QUERY_CORRELATION ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -1h) |> filter(fn: (r) => exists r.request_id or exists r.trace_id)`
          : "SELECT * FROM measurement WHERE (request_id != '' OR trace_id != '') AND time > now() - 1h LIMIT 20"),

      // Tag-based correlation
      tagBased:
        process.env.INFLUXDB_QUERY_TAG_CORR ||
        (process.env.INFLUXDB_VERSION === "2.x"
          ? `from(bucket: "${
              process.env.INFLUXDB_BUCKET || "test"
            }") |> range(start: -30m) |> group(columns: ["host", "service"])`
          : "SELECT * FROM measurement WHERE time > now() - 30m GROUP BY host, service LIMIT 10"),

      // Field to use for correlation
      correlationField: process.env.INFLUXDB_CORRELATION_FIELD || "host",
    },

    // Time ranges for queries
    timeRanges: {
      short: "5m", // Last 5 minutes
      medium: "30m", // Last 30 minutes
      long: "2h", // Last 2 hours
      veryLong: "24h", // Last 24 hours
    },
  },

  // Field mappings - customize based on your InfluxDB setup
  fieldMappings: {
    // Common InfluxDB fields
    measurement: process.env.INFLUXDB_FIELD_MEASUREMENT || "_measurement",
    time: process.env.INFLUXDB_FIELD_TIME || "time",
    value: process.env.INFLUXDB_FIELD_VALUE || "_value",
    field: process.env.INFLUXDB_FIELD_FIELD || "_field",

    // Common tags
    host: process.env.INFLUXDB_FIELD_HOST || "host",
    region: process.env.INFLUXDB_FIELD_REGION || "region",
    service: process.env.INFLUXDB_FIELD_SERVICE || "service",

    // Correlation ID fields (customize based on your setup)
    requestId: process.env.INFLUXDB_FIELD_REQUEST_ID || "request_id",
    traceId: process.env.INFLUXDB_FIELD_TRACE_ID || "trace_id",
    spanId: process.env.INFLUXDB_FIELD_SPAN_ID || "span_id",
    correlationId:
      process.env.INFLUXDB_FIELD_CORRELATION_ID || "correlation_id",
  },

  // Expected test results - helps validate tests are working
  expectations: {
    // Minimum number of results expected for basic queries
    minBasicData: parseInt(process.env.INFLUXDB_MIN_BASIC) || 0,
    minTimeSeries: parseInt(process.env.INFLUXDB_MIN_TIMESERIES) || 0,
    minAggregation: parseInt(process.env.INFLUXDB_MIN_AGG) || 0,

    // Expected fields in data (customize based on your schema)
    expectedFields: (
      process.env.INFLUXDB_EXPECTED_FIELDS || "_measurement,_time,_value"
    ).split(","),

    // Tags that might contain correlation IDs
    correlationFields: (
      process.env.INFLUXDB_CORRELATION_FIELDS ||
      "host,service,request_id,trace_id"
    ).split(","),
  },

  // Debug settings
  debug: {
    // Log raw InfluxDB responses
    logRawResponses: process.env.INFLUXDB_DEBUG_RAW === "true",

    // Log query transformations
    logQueryTransform: process.env.INFLUXDB_DEBUG_QUERIES === "true",

    // Save test results to file
    saveResults: process.env.INFLUXDB_SAVE_RESULTS === "true",
    resultsPath: process.env.INFLUXDB_RESULTS_PATH || "./test-results",
  },
};
