# TimeQL Queries on Persisted DuckDB Data

## Overview

TimeQL queries on persisted DuckDB data would allow you to analyze already-ingested events using the familiar TimeQL syntax, without fetching new data from external sources.

## Query Syntax Examples

### 1. Basic Event Queries

```timeql
# Query events from the persisted database
events[1h]

# Filter by labels/fields
events{application="frontend", http_status="500"}[30m]

# Filter by message content
events{message=~"error|failed"}[2h]
```

### 2. Correlation Queries on Existing Data

```timeql
# Correlate events already in DuckDB
events{source="frontend"}[1d] 
  and on(request_id) 
events{source="backend"}[1d]

# Left join to find all frontend events, enriched with backend data where available
events{tier="frontend"}[6h]
  or on(request_id)
events{tier="backend"}[6h]

# Anti-join to find frontend requests with no backend match
events{source="frontend"}[1h]
  unless on(request_id)
events{source="backend"}[1h]
```

### 3. Multi-Stream Correlations

```timeql
# Three-way correlation
events{service="api-gateway"}[1d]
  and on(request_id) events{service="auth-service"}[1d]
  and on(request_id) events{service="database"}[1d]

# Complex correlation with different join keys
events{type="order_created"}[7d]
  and on(order_id) events{type="payment_processed"}[7d]
  and on(customer_id) events{type="notification_sent"}[7d]
```

### 4. Aggregation Queries

```timeql
# Count events by service (PromQL-inspired aggregations)
sum by(service) (
  rate(events{_exists_="error"}[5m])
)

# Top 10 error sources
topk(10, 
  count by(source, error_type) (
    events{level="ERROR"}[1h]
  )
)

# Average response time by endpoint
avg by(endpoint) (
  events{metric_name="response_time"}[30m]
)
```

### 5. Time-based Analysis

```timeql
# Events from specific time range (absolute)
events{timestamp >= "2024-01-01T00:00:00Z" AND timestamp < "2024-01-02T00:00:00Z"}

# Rate of events over time
rate(events[5m])

# Increase in error rate
increase(events{level="ERROR"}[1h])
```

### 6. Pattern Detection

```timeql
# Find patterns across correlated events
events{service="frontend"}
  follows on(session_id) within(5m)
events{service="backend", status="500"}

# Detect cascading failures
events{type="service_down"}
  precedes on(cluster_id) within(30s)
events{type="service_down"}
```

## SQL Translation Examples

Here's how TimeQL queries would translate to DuckDB SQL:

### Simple Filter Query
```timeql
events{application="frontend", http_status="500"}[1h]
```

Translates to:
```sql
SELECT *
FROM events
WHERE json_extract_string(labels, '$.application') = 'frontend'
  AND json_extract_string(labels, '$.http_status') = '500'
  AND timestamp >= NOW() - INTERVAL '1 hour'
```

### Correlation Query
```timeql
events{source="frontend"}[1d] 
  and on(request_id) 
events{source="backend"}[1d]
```

Translates to:
```sql
WITH left_stream AS (
  SELECT *, 'left' as stream_side
  FROM events
  WHERE json_extract_string(labels, '$.source') = 'frontend'
    AND timestamp >= NOW() - INTERVAL '1 day'
),
right_stream AS (
  SELECT *, 'right' as stream_side
  FROM events  
  WHERE json_extract_string(labels, '$.source') = 'backend'
    AND timestamp >= NOW() - INTERVAL '1 day'
)
SELECT 
  l.request_id as join_value,
  'request_id' as join_key,
  ARRAY_AGG(DISTINCT l.*) as left_events,
  ARRAY_AGG(DISTINCT r.*) as right_events
FROM left_stream l
INNER JOIN right_stream r ON l.request_id = r.request_id
GROUP BY l.request_id
```

### Aggregation Query
```timeql
count by(service) (
  events{level="ERROR"}[1h]
)
```

Translates to:
```sql
SELECT 
  json_extract_string(labels, '$.service') as service,
  COUNT(*) as count
FROM events
WHERE json_extract_string(labels, '$.level') = 'ERROR'
  AND timestamp >= NOW() - INTERVAL '1 hour'
GROUP BY json_extract_string(labels, '$.service')
```

## Implementation Approach

### 1. Query Parser Extension

Extend the existing TimeQL parser to recognize when queries should run against persisted data:

```javascript
// Parse TimeQL for persisted data
const query = parseTimeQL('events{service="api"}[1h]');

// Detect if this is a persisted query (no source prefix)
if (query.source === 'events' || !query.source) {
  // Query persisted DuckDB data
  const sql = timeQLToSQL(query);
  const results = await duckdb.execute(sql);
}
```

### 2. Direct Query API

```javascript
const { TimeQLQueryClient } = require('@timebridge/core');

// Create client for persisted data
const client = new TimeQLQueryClient({
  databasePath: '/path/to/persisted/data.duckdb'
});

// Execute TimeQL queries directly
const results = await client.query(`
  events{application="frontend"}[1h]
    and on(request_id)
  events{application="backend"}[1h]
`);

// Or use SQL directly
const sqlResults = await client.sql(`
  SELECT * FROM events 
  WHERE timestamp > NOW() - INTERVAL '1 hour'
`);
```

### 3. Mixed Mode Queries

Support both persisted and streaming data:

```javascript
// Query persisted historical data AND stream new data
const results = await executor.query(`
  # Historical data from DuckDB
  events{service="api"}[7d from persisted]
    and on(request_id)
  # Live data from Graylog  
  graylog("service:api")[1h from stream]
`);
```

## Benefits

1. **Familiar Syntax**: Use the same TimeQL syntax for both streaming and persisted data
2. **Fast Analytics**: Leverage DuckDB's columnar storage for analytical queries
3. **No External Dependencies**: Query without connecting to external data sources
4. **Complex Correlations**: Perform multi-way joins efficiently on indexed data
5. **Time Travel**: Query historical data exactly as it was at ingestion time

## Advanced Features

### 1. Materialized Views

```timeql
# Create a materialized view for common queries
CREATE VIEW hourly_errors AS
  SELECT 
    DATE_TRUNC('hour', timestamp) as hour,
    service,
    COUNT(*) as error_count
  FROM events{level="ERROR"}
  GROUP BY 1, 2

# Query the view
SELECT * FROM hourly_errors WHERE hour >= NOW() - INTERVAL '24 hours'
```

### 2. Window Functions

```timeql
# Rank services by error rate
SELECT 
  service,
  error_count,
  RANK() OVER (ORDER BY error_count DESC) as rank
FROM (
  count by(service) (events{level="ERROR"}[1h])
)
```

### 3. Pattern Matching

```timeql
# Find sequences of events
MATCH_RECOGNIZE (
  PARTITION BY session_id
  ORDER BY timestamp
  PATTERN (login failed* success)
  DEFINE
    login AS event_type = 'login_attempt',
    failed AS event_type = 'login_failed',
    success AS event_type = 'login_success'
)
```

## Performance Considerations

1. **Index Join Keys**: Create indexes on frequently used join columns
2. **Partition by Time**: Partition data by day/hour for time-range queries
3. **Column Statistics**: Update statistics for optimal query planning
4. **Materialized Aggregates**: Pre-compute common aggregations
5. **Query Caching**: Cache frequently executed queries

## Roadmap

1. **Phase 1**: Basic TimeQL to SQL translation for persisted data
2. **Phase 2**: Aggregation functions and grouping
3. **Phase 3**: Pattern matching and sequence detection
4. **Phase 4**: Mixed streaming + persisted queries
5. **Phase 5**: Distributed query across multiple DuckDB instances