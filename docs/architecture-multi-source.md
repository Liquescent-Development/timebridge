# Multi-Source Query Architecture

## Overview

The log correlator should intelligently handle queries based on their syntax, automatically routing to the appropriate execution path (direct query vs correlation) and supporting multiple instances of the same adapter type.

## Key Design Principles

1. **Smart Default Behavior**: The library automatically detects query type from syntax
2. **Multi-Instance Support**: Support multiple instances of the same adapter type (e.g., graylog-prod, graylog-staging)
3. **Flexible Naming**: Allow custom names for data sources while maintaining backward compatibility
4. **Unified Interface**: Single `QueryExecutor` class that handles all query types

## Query Types

### Direct Queries

Single-source queries that don't require correlation:

```javascript
graylog(level:error)[5m]
graylog-prod(service:api)[10m]
loki-us-east({job="nginx"})[1h]
```

### Correlation Queries

Multi-source queries with join operations:

```javascript
graylog-prod(service:api)[5m] and on(request_id) graylog-staging(service:api)[5m]
loki({job="frontend"})[10m] or on(trace_id) loki({job="backend"})[10m]
```

## Implementation

### 1. QueryExecutor Class

The main entry point that:

- Analyzes queries to determine type
- Routes to appropriate execution path
- Manages adapter registration with flexible naming

```javascript
const executor = new QueryExecutor(options);

// Register adapters with custom names
executor.addAdapter("graylog-prod", prodAdapter);
executor.addAdapter("graylog-staging", stagingAdapter);
executor.addAdapter("loki-us", usLokiAdapter);

// Execute any query - automatically handled
for await (const result of executor.execute(query)) {
  // Process results
}
```

### 2. Adapter Registration

Supports three registration patterns:

#### Pattern 1: Base Type (Backward Compatible)

```javascript
executor.addAdapter("graylog", adapter);
// Query: graylog(query)[5m]
```

#### Pattern 2: Named Instances

```javascript
executor.addAdapter("graylog-prod", prodAdapter);
executor.addAdapter("graylog-staging", stagingAdapter);
// Query: graylog-prod(query)[5m]
```

#### Pattern 3: Default + Named

```javascript
executor.addAdapter("graylog", defaultAdapter, { isDefault: true });
executor.addAdapter("graylog-prod", prodAdapter);
// Query: graylog(query)[5m] uses default
// Query: graylog-prod(query)[5m] uses prod
```

### 3. Query Analysis

The `analyzeQuery` function examines the query string to determine:

- Query type (direct vs correlation)
- Required data sources
- Join operations

```javascript
function analyzeQuery(query: string): {
  type: 'direct' | 'correlation';
  sources: string[];
}
```

### 4. Adapter Resolution

Smart resolution that handles:

- Exact name matches (graylog-prod)
- Base type with defaults (graylog → default graylog adapter)
- Missing adapter detection with helpful errors

## Use Cases

### 1. Multi-Environment Correlation

```javascript
// Compare behavior across environments
graylog-dev(feature:new)[1h]
  and on(user_id)
graylog-staging(feature:new)[1h]
  and on(user_id)
graylog-prod(feature:new)[1h]
```

### 2. Regional Data Correlation

```javascript
// Track requests across regions
loki-us-east({service="api"})[5m]
  and on(trace_id)
loki-eu-west({service="api"})[5m]
```

### 3. Mixed Platform Queries

```javascript
// Correlate between different logging systems
graylog-prod(application:frontend)[10m]
  and on(session_id)
prometheus(http_requests_total)[10m]
```

### 4. Simple Direct Queries

```javascript
// Just query one source
graylog(level:error)[5m]
```

## Migration Path

### Current Usage (Still Supported)

```javascript
const engine = new CorrelationEngine();
engine.addAdapter("graylog", adapter);
engine.addAdapter("loki", adapter);

// Only works for correlation queries
for await (const correlation of engine.correlate(query)) {
  // Process
}
```

### New Usage (Recommended)

```javascript
const executor = new QueryExecutor();
executor.addAdapter("graylog", adapter);
executor.addAdapter("loki", adapter);

// Works for both direct and correlation queries
for await (const result of executor.execute(query)) {
  // Process
}
```

## Benefits

1. **Simplified API**: Users don't need to know if a query is direct or correlation
2. **Multi-Instance Support**: Essential for production environments with multiple deployments
3. **Backward Compatible**: Existing code continues to work
4. **Type Safety**: TypeScript support with proper typing
5. **Better Error Messages**: Clear feedback when adapters are missing

## Future Enhancements

1. **Adapter Auto-Discovery**: Automatically discover available data sources
2. **Query Optimization**: Optimize query execution based on data source capabilities
3. **Caching Layer**: Cache results for repeated queries
4. **Federation**: Support for federated queries across multiple organizations
5. **Query Templates**: Predefined query patterns for common use cases
