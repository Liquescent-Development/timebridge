#!/usr/bin/env node

const { 
  TimeQLExecutor, 
  QueryRouter,
  TimeQLQueryClient,
  queryPersistedData,
  isEventResult, 
  isCorrelationResult 
} = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Helper function to format a value for console display
function formatValue(value, maxLength = 40) {
  if (value === null || value === undefined || value === '') return '-';
  const str = String(value);
  if (str.length > maxLength) {
    return str.substring(0, maxLength - 3) + '...';
  }
  return str;
}

// Helper function to create a console table for a correlation
function printCorrelationTable(correlation, correlationIndex) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CORRELATION ${correlationIndex}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Join Key:   ${correlation.joinKey}`);
  console.log(`Join Value: ${correlation.joinValue}`);
  console.log(`Time Range: ${correlation.timeWindow?.start || 'N/A'} to ${correlation.timeWindow?.end || 'N/A'}`);
  console.log(`Events:     ${correlation.events?.length || 0}`);
  console.log(`${'─'.repeat(80)}`);

  if (correlation.events && correlation.events.length > 0) {
    // Collect all unique field names from all events
    const allFields = new Set(['timestamp', 'source', 'message']);
    correlation.events.forEach(event => {
      if (event.labels) {
        Object.keys(event.labels).forEach(key => allFields.add(key));
      }
    });

    // Remove fields we don't want to show in the main table
    allFields.delete('timestamp');
    allFields.delete('source');

    // Sort fields alphabetically
    const sortedFields = Array.from(allFields).sort();

    // Calculate column widths
    const fieldWidths = {};
    sortedFields.forEach(field => {
      let maxWidth = field.length;
      correlation.events.forEach(event => {
        const value = field === 'message' ? event.message : event.labels?.[field];
        if (value) {
          maxWidth = Math.max(maxWidth, String(value).length);
        }
      });
      // Cap widths for readability
      fieldWidths[field] = Math.min(maxWidth, field === 'message' ? 60 : 30);
    });

    // Print header
    console.log(`\n${'─'.repeat(80)}`);
    console.log('EVENT DETAILS:');
    console.log(`${'─'.repeat(80)}`);

    // Print each event
    correlation.events.forEach((event, idx) => {
      console.log(`\nEvent ${idx + 1}:`);
      console.log(`  Timestamp: ${event.timestamp}`);
      console.log(`  Source:    ${event.source || '-'}`);

      // Print message if exists
      if (event.message) {
        const messageLines = event.message.match(/.{1,70}/g) || [];
        console.log(`  Message:   ${messageLines[0] || '-'}`);
        messageLines.slice(1).forEach(line => {
          console.log(`             ${line}`);
        });
      }

      // Print other important fields
      const importantFields = [
        'timestamp',
        'source',
        'message',
        'request_id',
        'application',
        'tier',
        'spc_tier',
        'http_status',
        'http_status_class',
        'account_id',
        'request_account_id',
        'request_principal',
        'user_agent',
        'action'
      ];

      const relevantFields = {};
      importantFields.forEach(field => {
        if (event.labels?.[field]) {
          relevantFields[field] = event.labels[field];
        }
      });

      if (Object.keys(relevantFields).length > 0) {
        console.log(`  Fields:`);
        Object.entries(relevantFields).forEach(([key, value]) => {
          console.log(`    ${key.padEnd(20)} : ${formatValue(value, 50)}`);
        });
      }
    });
  }

  console.log(`\n${'='.repeat(80)}\n`);
}

// Helper to escape CSV value
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function main() {
  // ================================================================================
  // NEW FEATURE: Database Persistence Configuration
  // ================================================================================
  
  const PERSIST_DATA = true;  // Enable persistence to keep DuckDB data after query
  const DATABASE_NAME = `graylog_${new Date().toISOString().split('T')[0]}`;  // Daily database
  const PERSIST_PATH = path.join(os.homedir(), '.timebridge', 'databases');
  
  // Create persistence directory if it doesn't exist
  if (PERSIST_DATA) {
    await fs.promises.mkdir(PERSIST_PATH, { recursive: true });
    console.log(`\n💾 Database Persistence Enabled:`);
    console.log(`   ├─ Database Name: ${DATABASE_NAME}`);
    console.log(`   └─ Storage Path: ${PERSIST_PATH}`);
  }

  // ================================================================================
  // OPTIMIZED CONFIGURATION WITH PERSISTENCE
  // ================================================================================

  // Option 1: Use QueryRouter for automatic persistence
  const router = new QueryRouter({
    // Force DuckDB for all queries (ensures persistence works)
    forceEngine: 'duckdb',
    
    // NEW: Enable persistence
    persistData: PERSIST_DATA,
    persistPath: PERSIST_PATH,
    databaseName: DATABASE_NAME,
    
    // Performance optimizations
    duckdbBatchSize: 2000000,  // 2M events per batch
    timeWindowThreshold: 24 * 60 * 60 * 1000,
    eventCountThreshold: 100000,
    maxEvents: 100000000,
  });

  // Option 2: Traditional executor (for backward compatibility)
  const executor = new TimeQLExecutor({
    duckdbBatchSize: 2000000,
    timeWindowThreshold: 24 * 60 * 60 * 1000,
    eventCountThreshold: 100000,
    maxEvents: 100000000,
    forceEngine: 'duckdb',
  });

  // ================================================================================
  // ADAPTER CONFIGURATION
  // ================================================================================

  const CORRELATION_FIELDS = ['request_id', 'hostname'];
  const ESSENTIAL_FIELDS = [
    'timestamp',
    'source',
    'message',
    'application',
    'tier',
    'spc_tier',
    'http_status',
    'http_status_class',
    'account_id',
    'request_account_id',
    'request_principal',
    'user_agent',
    'action'
  ];
  
  const fields = [...CORRELATION_FIELDS, ...ESSENTIAL_FIELDS];

  const adapters = new Map();
  
  const graylogApNe = new GraylogAdapter({
    url: process.env.GRAYLOG_AP_NE_URL,
    username: process.env.GRAYLOG_USERNAME,
    password: process.env.GRAYLOG_PASSWORD,
    proxy: {
      host: "127.0.0.1",
      port: 1080,
      type: 5,
    },
    streamName: "",
    apiVersion: "v6",
    fields: fields,
    maxResults: 100000000,
  });
  
  const graylogApSe = new GraylogAdapter({
    url: process.env.GRAYLOG_AP_SE_URL,
    username: process.env.GRAYLOG_USERNAME,
    password: process.env.GRAYLOG_PASSWORD,
    proxy: {
      host: "127.0.0.1",
      port: 1080,
      type: 5,
    },
    streamName: "",
    apiVersion: "v6",
    fields: fields,
    maxResults: 100000000,
  });

  adapters.set("graylog-ap-northeast-1", graylogApNe);
  adapters.set("graylog-ap-southeast-1", graylogApSe);
  
  // Also add to executor for traditional queries
  executor.addAdapter("graylog-ap-northeast-1", graylogApNe);
  executor.addAdapter("graylog-ap-southeast-1", graylogApSe);

  // ================================================================================
  // EXAMPLE 1: Traditional Correlation Query with Persistence
  // ================================================================================

  console.log("\n" + "=".repeat(80));
  console.log("EXAMPLE 1: Traditional Correlation Query with Persistence");
  console.log("=".repeat(80));

  const correlationQuery = `
    graylog-ap-southeast-1:vm(hostname:sin202-0219-h05 AND _exists_:request_id)[2d]
      or on(request_id)
    graylog-ap-southeast-1:vm(message:failed to transmit* AND _exists_:request_id)[2d]
  `;

  console.log("\n🔍 Executing TimeQL Correlation Query...\n");
  console.log(correlationQuery);

  const startTime = Date.now();
  let correlationCount = 0;
  let eventCount = 0;

  // Parse the query
  const { PeggyQueryParser } = require("@timebridge/timeql-parser");
  const parser = new PeggyQueryParser();
  const parsedQuery = parser.parse(correlationQuery);

  // Execute with persistence
  console.log("\n⚙️  Using QueryRouter with DuckDB persistence...");
  
  for await (const result of router.execute(parsedQuery, adapters)) {
    if (isCorrelationResult(result)) {
      correlationCount++;
      if (correlationCount <= 3) {
        printCorrelationTable(result.data, correlationCount);
      }
    } else if (isEventResult(result)) {
      eventCount++;
    }
    
    // Progress indicator
    if ((correlationCount + eventCount) % 1000 === 0) {
      process.stdout.write(`\r  📊 Progress: ${correlationCount} correlations, ${eventCount} events...`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n\n✅ Query Complete in ${elapsed} seconds`);
  console.log(`   ├─ Correlations: ${correlationCount}`);
  console.log(`   └─ Events: ${eventCount}`);

  if (PERSIST_DATA) {
    console.log(`\n💾 Data persisted to: ${path.join(PERSIST_PATH, DATABASE_NAME + '.duckdb')}`);
  }

  // ================================================================================
  // EXAMPLE 2: Query Persisted Data Using TimeQL
  // ================================================================================

  if (PERSIST_DATA && correlationCount > 0) {
    console.log("\n" + "=".repeat(80));
    console.log("EXAMPLE 2: Query Persisted Database with TimeQL");
    console.log("=".repeat(80));

    const client = new TimeQLQueryClient({
      databasePath: PERSIST_PATH
    });

    try {
      // List available databases
      console.log("\n📚 Available Databases:");
      const databases = await client.listDatabases();
      databases.forEach(db => {
        const sizeStr = db.sizeBytes ? `${(db.sizeBytes / 1024 / 1024).toFixed(2)} MB` : 'Unknown';
        console.log(`   ├─ ${db.name} (${sizeStr}, ${db.eventCount || '?'} events)`);
      });

      // Load our database
      console.log(`\n📂 Loading database: ${DATABASE_NAME}`);
      await client.loadDatabase(DATABASE_NAME);

      // Example TimeQL queries on persisted data
      console.log("\n📊 Running TimeQL Queries on Persisted Data:");

      // Query 1: Count events by source
      console.log("\n1. Count events by source:");
      const countBySource = await client.query(`
        count by(source) (events[24h])
      `);
      console.table(countBySource.slice(0, 5));

      // Query 2: Filter by specific criteria
      console.log("\n2. Find error events:");
      const errorEvents = await client.query(`
        events{level="error"}[24h]
      `);
      console.log(`   Found ${errorEvents.length} error events`);

      // Query 3: Aggregation example
      console.log("\n3. Average response times by service:");
      const avgByService = await client.query(`
        avg by(service) (events{_exists_:response_time}[24h])
      `);
      if (avgByService.length > 0) {
        console.table(avgByService.slice(0, 5));
      }

      await client.close();
    } catch (error) {
      console.error("Error querying persisted data:", error.message);
    }
  }

  // ================================================================================
  // EXAMPLE 3: Pattern Matching Queries (New Feature!)
  // ================================================================================

  console.log("\n" + "=".repeat(80));
  console.log("EXAMPLE 3: Pattern Matching Queries");
  console.log("=".repeat(80));

  // These queries would work on persisted data
  const patternExamples = [
    {
      name: "Login followed by API access",
      query: `events{action="login"}[5m] follows events{endpoint="/api/dashboard"}[5m] within(30s)`
    },
    {
      name: "Errors before alerts",
      query: `events{level="error"}[1h] before events{type="alert"}[1h]`
    },
    {
      name: "Database updates precede cache invalidation",
      query: `events{source="database", operation="UPDATE"}[30m] precedes events{source="cache", action="invalidate"}[30m] within(5m)`
    }
  ];

  console.log("\n📝 Example Pattern Queries (syntax demonstration):");
  patternExamples.forEach((example, idx) => {
    console.log(`\n${idx + 1}. ${example.name}:`);
    console.log(`   ${example.query}`);
  });

  // ================================================================================
  // EXAMPLE 4: Demonstrate CLI Usage
  // ================================================================================

  console.log("\n" + "=".repeat(80));
  console.log("EXAMPLE 4: TimeQL CLI Usage");
  console.log("=".repeat(80));

  console.log("\n🖥️  TimeQL CLI Commands:");
  console.log("\nList databases:");
  console.log("  $ timeql list");
  
  console.log("\nQuery a database:");
  console.log(`  $ timeql query ${DATABASE_NAME} 'events{level="error"}[1h]'`);
  
  console.log("\nInteractive REPL:");
  console.log(`  $ timeql repl ${DATABASE_NAME}`);
  
  console.log("\nExport database:");
  console.log(`  $ timeql export ${DATABASE_NAME} ./backup.duckdb`);
  
  console.log("\nGet database info:");
  console.log(`  $ timeql info ${DATABASE_NAME}`);

  // ================================================================================
  // EXAMPLE 5: Advanced DuckDB Features
  // ================================================================================

  console.log("\n" + "=".repeat(80));
  console.log("EXAMPLE 5: Advanced DuckDB Features");
  console.log("=".repeat(80));

  if (PERSIST_DATA) {
    const client = new TimeQLQueryClient({
      databasePath: PERSIST_PATH
    });

    try {
      await client.loadDatabase(DATABASE_NAME);

      console.log("\n🚀 Direct SQL Queries on Persisted Data:");

      // Example: Complex analytics query
      const analyticsSQL = `
        WITH hourly_stats AS (
          SELECT 
            date_trunc('hour', timestamp) as hour,
            source,
            COUNT(*) as event_count,
            COUNT(DISTINCT json_extract_string(labels, '$.request_id')) as unique_requests
          FROM events
          WHERE timestamp >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
          GROUP BY 1, 2
        )
        SELECT 
          hour,
          source,
          event_count,
          unique_requests,
          ROUND(100.0 * event_count / SUM(event_count) OVER (PARTITION BY hour), 2) as pct_of_hour
        FROM hourly_stats
        ORDER BY hour DESC, event_count DESC
        LIMIT 10
      `;

      console.log("\nHourly statistics with percentage breakdown:");
      const stats = await client.sql(analyticsSQL);
      if (stats.length > 0) {
        console.table(stats);
      }

      // Example: Pattern detection with window functions
      const patternSQL = `
        WITH event_patterns AS (
          SELECT 
            timestamp,
            source,
            message,
            LAG(source) OVER (ORDER BY timestamp) as prev_source,
            LEAD(source) OVER (ORDER BY timestamp) as next_source,
            timestamp - LAG(timestamp) OVER (ORDER BY timestamp) as time_since_prev
          FROM events
          WHERE timestamp >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
        )
        SELECT 
          timestamp,
          source,
          prev_source || ' -> ' || source || ' -> ' || next_source as pattern,
          EXTRACT(EPOCH FROM time_since_prev) as seconds_since_prev
        FROM event_patterns
        WHERE prev_source IS NOT NULL 
          AND next_source IS NOT NULL
          AND prev_source != source
          AND source != next_source
        LIMIT 5
      `;

      console.log("\nEvent sequence patterns detected:");
      const patterns = await client.sql(patternSQL);
      if (patterns.length > 0) {
        patterns.forEach(p => {
          console.log(`  ${p.pattern} (${p.seconds_since_prev?.toFixed(2)}s gap)`);
        });
      }

      await client.close();
    } catch (error) {
      console.error("Error with advanced queries:", error.message);
    }
  }

  // ================================================================================
  // Performance Summary
  // ================================================================================

  console.log("\n" + "=".repeat(80));
  console.log("PERFORMANCE SUMMARY");
  console.log("=".repeat(80));

  const memUsage = process.memoryUsage();
  console.log("\n📊 Resource Usage:");
  console.log(`   ├─ Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`);
  console.log(`   ├─ Total Memory: ${Math.round(memUsage.rss / 1024 / 1024)} MB`);
  console.log(`   └─ External: ${Math.round(memUsage.external / 1024 / 1024)} MB`);

  if (PERSIST_DATA) {
    try {
      const dbFile = path.join(PERSIST_PATH, DATABASE_NAME + '.duckdb');
      const stats = await fs.promises.stat(dbFile);
      console.log("\n💾 Persisted Database:");
      console.log(`   ├─ Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   ├─ Created: ${stats.birthtime.toLocaleString()}`);
      console.log(`   └─ Path: ${dbFile}`);
    } catch (error) {
      // Database might not exist
    }
  }

  console.log("\n✨ New Features Demonstrated:");
  console.log("   ✅ Always use DuckDB for query processing");
  console.log("   ✅ Persist query results as DuckDB database");
  console.log("   ✅ Query persisted data using TimeQL");
  console.log("   ✅ Pattern matching queries (follows, precedes, before, after)");
  console.log("   ✅ Direct SQL queries on persisted data");
  console.log("   ✅ CLI tool for database management");
  console.log("   ✅ Aggregation queries on persisted data");
  
  console.log("\n🎉 TimeQL Enhanced Features Successfully Demonstrated!");
}

// Run the main function
main().catch(error => {
  console.error("❌ Error:", error);
  process.exit(1);
});