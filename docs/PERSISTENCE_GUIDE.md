# TimeQL DuckDB Persistence Guide

## Overview

This guide explains how to configure TimeQL to always use DuckDB and persist data for later querying.

## Configuration

### 1. Always Use DuckDB

To force all queries to use DuckDB instead of the in-memory StreamJoiner:

```javascript
const { TimeQLExecutor } = require("@timebridge/core");

const executor = new TimeQLExecutor({
  // Force DuckDB for all queries
  forceEngine: 'duckdb',
  
  // Configure DuckDB settings
  duckdbBatchSize: 2000000,  // 2M events per batch
  maxEvents: 100000000,      // 100M event limit
});
```

### 2. Persist Data (Coming Soon)

The persistence feature would allow you to keep DuckDB data after query completion:

```javascript
const executor = new TimeQLExecutor({
  forceEngine: 'duckdb',
  
  // Persistence configuration (planned feature)
  persistData: true,
  persistPath: '/path/to/persist/directory',
  databaseName: 'my_timeql_db',
  cleanupAfterDays: 7  // Auto-cleanup old databases
});
```

## Current Workaround

Until the persistence feature is fully implemented, you can achieve similar results by:

### 1. Using DuckDB Directly

After a query completes, the data is already in DuckDB. You can access it directly:

```javascript
// Get the DuckDB executor instance
const duckdb = executor.getDuckDB();

// Execute SQL queries directly
const results = await duckdb.execute(`
  SELECT * FROM events 
  WHERE timestamp > NOW() - INTERVAL '1 hour'
`);
```

### 2. Export Data

Export the data to Parquet files for persistence:

```javascript
// Export to Parquet
await duckdb.execute(`
  COPY (SELECT * FROM events) 
  TO 'events.parquet' (FORMAT PARQUET)
`);

// Later, import it back
await duckdb.execute(`
  CREATE TABLE events AS 
  SELECT * FROM 'events.parquet'
`);
```

### 3. Keep Session Alive

Keep your executor instance alive to maintain the DuckDB session:

```javascript
// Create a singleton executor
let globalExecutor;

function getExecutor() {
  if (!globalExecutor) {
    globalExecutor = new TimeQLExecutor({
      forceEngine: 'duckdb',
      duckdbBatchSize: 2000000,
      maxEvents: 100000000,
    });
  }
  return globalExecutor;
}

// Use the same executor for multiple queries
const executor = getExecutor();
```

## Query Persisted Data

Once data is in DuckDB, you can query it using SQL or TimeQL:

### Using SQL

```javascript
const executor = getExecutor();
const duckdb = executor.getDuckDB();

// Direct SQL query
const results = await duckdb.execute(`
  SELECT 
    source,
    COUNT(*) as event_count,
    MIN(timestamp) as first_seen,
    MAX(timestamp) as last_seen
  FROM events
  GROUP BY source
`);
```

### Using TimeQL (via SQL Generation)

```javascript
const { TimeQLToSQLGenerator } = require("@timebridge/core");

const generator = new TimeQLToSQLGenerator();
const query = parseTimeQL(yourTimeQLQuery); // Parse your TimeQL
const sql = generator.generateSQL(query);
const results = await duckdb.execute(sql);
```

## Performance Tips

1. **Always use DuckDB** for large datasets (> 100K events)
2. **Increase batch size** to 2-5M for faster ingestion
3. **Pre-filter fields** in your adapter configuration
4. **Use CSV streaming** when available (Graylog adapter)
5. **Enable semi-join optimization** for asymmetric correlations

## Example: Large Dataset Processing

```javascript
const { TimeQLExecutor } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");

async function processLargeDataset() {
  // Create executor with optimal settings
  const executor = new TimeQLExecutor({
    forceEngine: 'duckdb',
    duckdbBatchSize: 5000000,  // 5M batch size
    maxEvents: 1000000000,      // 1B event limit
    enableSemiJoinOptimization: true,
  });

  // Configure adapter with minimal fields
  executor.addAdapter("graylog", new GraylogAdapter({
    url: process.env.GRAYLOG_URL,
    fields: ['timestamp', 'request_id', 'hostname', 'message'],
    maxResults: 100000000,
  }));

  // Execute query
  const query = `
    graylog("hostname:server1")[2d]
      and on(request_id)
    graylog("error")[2d]
  `;

  // Process results
  for await (const result of executor.execute(query)) {
    // Results stream in as they're correlated
    console.log(result);
  }

  // Data remains in DuckDB for further analysis
  const duckdb = executor.getDuckDB();
  
  // Run analytical queries
  const stats = await duckdb.execute(`
    SELECT 
      DATE_TRUNC('hour', timestamp) as hour,
      COUNT(*) as correlations
    FROM events
    WHERE stream = 'correlated'
    GROUP BY 1
    ORDER BY 1
  `);

  return stats;
}
```

## Roadmap

The following features are planned for future releases:

1. **Automatic Persistence**: Option to automatically persist DuckDB data after queries
2. **Database Management**: APIs to list, load, and manage persisted databases
3. **TimeQL Direct Queries**: Query persisted data directly with TimeQL syntax
4. **Incremental Updates**: Add new data to existing persisted databases
5. **Distributed Query**: Query across multiple persisted databases

## Current Limitations

1. Data is only persisted for the session duration
2. No built-in database management UI
3. Manual export/import required for true persistence
4. TimeQL queries always stream fresh data (can't query only persisted data)

## Recommendations

For production use with large datasets:

1. **Use `forceEngine: 'duckdb'`** - Always use DuckDB
2. **Export important results** - Use Parquet export for long-term storage
3. **Keep sessions alive** - Maintain executor instances for repeated queries
4. **Monitor memory usage** - DuckDB can use significant memory with large datasets
5. **Use batch operations** - Process data in batches for better performance