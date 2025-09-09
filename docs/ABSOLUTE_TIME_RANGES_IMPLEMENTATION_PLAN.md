# TimeQL Absolute Time Ranges Implementation Plan

## Overview
Add support for absolute time ranges in TimeQL queries while maintaining backwards compatibility with existing relative time range syntax. After reviewing Prometheus's approach with `@` and `offset` modifiers, we need to design something that makes sense for TimeQL's correlation-focused use cases.

## Current System Behaviors

### Prometheus
- Uses `@` modifier for absolute time: `http_requests_total @ 1609746000`
- Uses `offset` for relative adjustments: `http_requests_total offset 5m`
- Range vectors still use brackets: `rate(http_requests_total[5m] @ 1609746000)`

### Loki (LogQL)
- Similar to Prometheus with `@` and `offset`
- Time ranges in API parameters, not query syntax

### Graylog & Others
- Time ranges typically in API parameters
- Query syntax focuses on filters, not time

## Proposed TimeQL Approach

Since TimeQL is designed for log correlation across multiple sources with potentially different query languages, we should handle absolute time ranges at the TimeQL level, not within each source's query syntax.

### Option A: Range in Brackets (TimeQL-specific)
```
# Absolute range - processed by TimeQL, not passed to underlying systems
graylog(service:notification)[2024-01-15T10:00:00Z to 2024-01-15T18:00:00Z]

# This would translate to Graylog API call with from/to parameters
# NOT passed as part of the Graylog query syntax
```

### Option B: @ Modifier Style (Following Prometheus Pattern)
```
# Query at specific time
graylog(service:notification) @ 2024-01-15T10:00:00Z

# Query with range from specific time
graylog(service:notification)[1h] @ 2024-01-15T10:00:00Z
```

### Option C: Explicit Range Function
```
# Separate time range from query
range(2024-01-15T10:00:00Z, 2024-01-15T18:00:00Z) | graylog(service:notification)

# Or as parameters
graylog(service:notification, from="2024-01-15T10:00:00Z", to="2024-01-15T18:00:00Z")
```

## Recommendation: Hybrid Approach

Use **Option A** for absolute ranges but clarify that these are TimeQL-level directives, not passed to underlying query languages:

```
# Relative range (current behavior)
graylog(service:notification)[1h]  # Last 1 hour

# Absolute range (new)
graylog(service:notification)[2024-01-15T10:00:00Z to 2024-01-15T18:00:00Z]

# @ modifier for point-in-time (new)
graylog(service:notification) @ 2024-01-15T10:00:00Z  # At specific time

# @ with range (new)
graylog(service:notification)[1h] @ 2024-01-15T10:00:00Z  # 1 hour from specific time
```

This approach:
1. Keeps time ranges in the familiar bracket syntax
2. Adds @ modifier for point-in-time queries (aligning with Prometheus)
3. TimeQL handles time range interpretation and passes appropriate parameters to each adapter
4. Underlying systems (Graylog, Loki, etc.) receive time as API parameters, not query syntax

## Implementation Tasks

### Phase 1: Parser Updates

#### 1.1 Grammar Definition Updates
**File:** `/workspace/packages/query-parser/grammar/timeql.peggy`

- [x] Add ISO 8601 timestamp token rules
  - [x] Full timestamp with 'T' separator
  - [x] Date-only format (YYYY-MM-DD)
  - [x] Timezone suffix patterns (Z, +/-HH:MM)
- [x] Add "to" keyword token
- [x] Add "now" keyword token
- [x] Add "ago" keyword token for relative references
- [x] Update TimeRange rule to support both formats:
  - [x] Existing: `Duration` (e.g., "5m", "1h", "7d")
  - [x] New: `AbsoluteTimeRange` with "to" separator
  - [x] Mixed: `Timestamp "to" RelativeRef` and vice versa
- [x] Ensure backwards compatibility with existing relative syntax

#### 1.2 Parser Generator Updates
**File:** `/workspace/packages/query-parser/src/parser.ts`

- [x] Regenerate parser from updated grammar
- [x] Update TypeScript interfaces for new AST nodes:
  ```typescript
  interface AbsoluteTimeRange {
    type: 'absolute';
    start: Timestamp | RelativeTime;
    end: Timestamp | RelativeTime;
  }
  ```
- [x] Add validation for timestamp formats
- [x] Add timezone parsing and normalization

#### 1.3 Parser Tests
**File:** `/workspace/packages/query-parser/src/absolute-time-ranges.test.ts`

- [x] Test cases for absolute ranges
- [x] Test cases for mixed ranges
- [x] Test cases for timezone handling
- [x] Test backwards compatibility with relative ranges
- [x] Test error cases (invalid dates, reversed ranges)

### Phase 2: Query Execution Updates

#### 2.1 Query Router Updates
**File:** `/workspace/packages/core/src/query-router.ts`

- [x] Update `routeQuery` to handle absolute time ranges
- [x] Convert absolute timestamps to adapter-specific formats
- [x] Handle timezone conversions if needed
- [x] Pass absolute range info to adapters

#### 2.2 TimeQL to SQL Converter
**File:** `/workspace/packages/core/src/timeql-to-sql.ts`

- [x] Update `parseTimeWindow` to handle absolute ranges
- [x] Generate SQL with absolute timestamp comparisons:
  ```sql
  WHERE timestamp >= TIMESTAMP '2024-01-15T10:00:00Z' 
    AND timestamp <= TIMESTAMP '2024-01-15T18:00:00Z'
  ```
- [x] Handle mixed relative/absolute in SQL generation
- [x] Ensure proper timezone handling in SQL

### Phase 3: Adapter Updates

#### 3.1 Graylog Adapter
**File:** `/workspace/packages/adapters/graylog/src/graylog-adapter.ts`

- [x] Update `createHistoricalStream` to accept absolute ranges
- [x] Modify API request parameters:
  - [x] Change from relative `range` parameter
  - [x] Use explicit `from` and `to` ISO timestamps
- [x] Update `parseTimeRange` to handle new format
- [x] Test with Graylog API v5 and v6
- [x] Handle timezone conversion (Graylog expects UTC)

#### 3.2 Loki Adapter
**File:** `/workspace/packages/adapters/loki/src/loki-adapter.ts`

- [x] Update query building for absolute ranges
- [x] Modify LogQL query generation
- [x] Update API request parameters:
  - [x] `start` and `end` as Unix nanoseconds
- [x] Handle timezone conversions
- [x] Test with Loki API

#### 3.3 Prometheus Adapter
**File:** `/workspace/packages/adapters/prometheus/src/prometheus-adapter.ts`

- [ ] Update PromQL query generation
- [ ] Handle absolute time in `query_range` endpoint
- [ ] Convert to Unix timestamps for API
- [ ] Test with Prometheus API

#### 3.4 InfluxDB Adapter
**File:** `/workspace/packages/adapters/influxdb/src/influxdb-adapter.ts`

- [ ] Update InfluxQL query generation
- [ ] Handle absolute time in WHERE clauses
- [ ] Test with InfluxDB API

### Phase 4: DuckDB Integration

#### 4.1 DuckDB Executor
**File:** `/workspace/packages/core/src/duckdb-executor.ts`

- [ ] Ensure absolute timestamps work in SQL queries
- [ ] Handle timezone conversions for stored data
- [ ] Update any time-based partitioning logic
- [ ] Test query performance with absolute ranges

#### 4.2 Query Optimizer
**File:** `/workspace/packages/core/src/query-optimizer.ts`

- [ ] Update optimization rules for absolute ranges
- [ ] Consider partition pruning with absolute dates
- [ ] Update semi-join optimization for absolute ranges

### Phase 5: Testing & Documentation

#### 5.1 Integration Tests
**File:** `/workspace/packages/core/src/correlation-engine.integration.test.ts`

- [ ] Add tests for absolute range correlations
- [ ] Test mixed relative/absolute scenarios
- [ ] Test timezone edge cases
- [ ] Test with real adapter connections

#### 5.2 Documentation Updates
**File:** `/workspace/docs/TIMEQL_SPECIFICATION.md`

- [x] Document new absolute range syntax
- [x] Add examples for each format
- [x] Document timezone behavior
- [x] Update query examples

**File:** `/workspace/README.md`

- [ ] Update main documentation with examples
- [ ] Add migration notes for users

#### 5.3 Example Updates
**Directory:** `/workspace/packages/examples/`

- [ ] Add example using absolute time ranges
- [ ] Update existing examples to show both styles
- [ ] Create timezone handling example

### Phase 6: CLI and Tools

#### 6.1 Dashboard Generator
**File:** `/workspace/generate-dashboard.js`

- [ ] Handle absolute ranges in query metadata
- [ ] Display absolute range info in dashboard
- [ ] Show timezone information clearly

#### 6.2 Debug Tools
**File:** `/workspace/debug-correlation-detailed.js`

- [ ] Support absolute ranges in debug commands
- [ ] Display range info in debug output

## Technical Considerations

### Timezone Handling Strategy
1. **Storage**: Always store in UTC in DuckDB
2. **Input**: Accept UTC (Z) or explicit offset (+/-HH:MM)
3. **Display**: Show with explicit timezone indicator
4. **Conversion**: Convert at adapter level before API calls

### Backwards Compatibility
- Existing queries with `[5m]` syntax must continue working
- No breaking changes to public API
- Deprecation warnings only if needed

### Performance Considerations
- Absolute ranges may allow better partition pruning
- Index usage for timestamp columns critical
- Consider caching for repeated absolute range queries

### Error Handling
- Invalid date formats
- End time before start time
- Future dates (configurable whether to allow)
- Timezone parsing errors
- Mixed timezone offsets

## Testing Strategy

### Unit Tests
- Parser: Grammar rule coverage
- Adapters: API call formation
- SQL generation: Correct WHERE clauses

### Integration Tests
- End-to-end with each adapter
- Correlation across absolute ranges
- Mixed adapter queries

### Performance Tests
- Large absolute ranges
- Many small absolute ranges
- Comparison vs relative ranges

## Rollout Plan

1. **Phase 1-2**: Core parser and query routing (Week 1)
2. **Phase 3**: Adapter updates, one at a time (Week 2)
3. **Phase 4**: DuckDB and optimization (Week 3)
4. **Phase 5**: Testing and documentation (Week 4)
5. **Phase 6**: Tools and utilities (Week 4)

## Success Criteria

- [ ] All existing tests pass (backwards compatibility)
- [ ] Can query: `graylog()[2024-01-15T10:00:00Z to 2024-01-15T18:00:00Z]`
- [ ] Can query: `loki()[2024-01-15 to 2024-01-16]`
- [ ] Can query: `graylog()[1d ago to now]`
- [ ] Correct results from all adapters
- [ ] Performance comparable to relative ranges
- [ ] Clear documentation and examples

## Open Questions

1. Should we allow future dates in absolute ranges?
2. Should we support named timezones (e.g., "America/Phoenix")?
3. Should we add shortcuts like "yesterday", "last week"?
4. How to handle DST transitions in absolute ranges?
5. Should we validate that end > start at parse time or runtime?

## Notes

- Priority is maintaining backwards compatibility
- Focus on UTC first, add timezone complexity later if needed
- Consider adding query validation warnings for very large absolute ranges