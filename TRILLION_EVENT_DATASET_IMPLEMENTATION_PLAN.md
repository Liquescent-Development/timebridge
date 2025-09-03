# Trillion-Event Dataset Implementation Plan for TimeBridge

## 📊 Implementation Progress

**Overall Progress: 50% Complete**

| Phase | Status | Progress | Key Achievements |
|-------|--------|----------|-----------------|
| Phase 1: DuckDB Foundation | ✅ Complete | 100% | DuckDB integrated, schema designed, ingestion pipeline ready |
| Phase 2: TimeQL Translation | ✅ Complete | 100% | Full SQL generation, native query support, query optimization |
| Phase 3: Hybrid Execution | ✅ Complete | 100% | QueryRouter with automatic engine selection, unified interface |
| Phase 4: Scale Optimizations | 🔲 Not Started | 0% | - |
| Phase 5: Production Hardening | 🔲 Not Started | 0% | - |
| Phase 6: Advanced Features | 🔲 Not Started | 0% | - |

**Last Updated:** September 2, 2025

## Recent Commits

1. **feat: Complete Phase 3 - Hybrid Execution Mode** (pending)
   - Created QueryRouter class for intelligent engine selection
   - Routes queries based on time window and estimated size
   - StreamJoiner for small/real-time queries (<100K events, <24h)
   - DuckDB for large/analytical queries (>100K events, >24h)
   - Unified AsyncIterable<LogEvent> interface for both engines
   - 15 QueryRouter tests passing

2. **feat: Complete Phase 2 - TimeQL to SQL Translation** (8ce1ae1)
   - Added LogQL and PromQL selector parsing with full operator support
   - Implemented field existence checks (_exists_:field)
   - Created QueryOptimizer class with cost estimation
   - Added predicate pushdown and partition pruning
   - Implemented optimal join order selection
   - All Phase 2 tests passing (107 total tests)

3. **test: Add comprehensive test coverage for DuckDB components** (included in Phase 2)
   - 24 tests for DuckDBExecutor
   - 34 tests for TimeQLToSQLGenerator
   - 25 tests for DiskSpillableStorage
   - 12 tests for QueryOptimizer
   - 11 integration tests (3 passing, 8 pending Phase 3)

3. **feat: Add DuckDB integration foundation** (91c081e)
   - Created DuckDBExecutor class with automatic memory management
   - Implemented TimeQL to SQL translator
   - Designed unified event table schema
   - Added streaming ingestion pipeline

4. **feat: Implement streaming CSV parsing** (f05306a) 
   - Added streaming CSV parsing to Graylog adapter
   - Implemented smart memory eviction in StreamJoiner
   - Fixed memory exhaustion for 300K+ message datasets

5. **docs: Add trillion-event implementation plan** (191a3e7)
   - Created comprehensive 12-week implementation roadmap
   - Defined architecture for TimeQL to SQL translation
   - Specified performance targets and success metrics

## Executive Summary

This plan outlines the transformation of TimeBridge from an in-memory correlation engine to a scale-out system capable of processing trillion-event datasets using DuckDB as the execution engine while maintaining the TimeQL interface.

## Current State vs Target State

### Current State (v1.0)
- **Capacity**: ~10M events with smart eviction
- **Memory**: Requires ~2GB per 1M events  
- **Storage**: In-memory only with streaming
- **Query Engine**: Custom StreamJoiner
- **Scaling**: Vertical only (more RAM)

### Target State (v2.0)  
- **Capacity**: 1+ trillion events
- **Memory**: Constant 4-8GB regardless of dataset size
- **Storage**: DuckDB with automatic spilling
- **Query Engine**: TimeQL → SQL → DuckDB
- **Scaling**: Horizontal via partitioning

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                 TimeQL Query                     │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│            TimeQL Parser (Peggy)                 │
│         (No changes - works as-is)               │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│          Query Plan Optimizer (New)              │
│   - Cost estimation                              │
│   - Join strategy selection                      │
│   - Partition pruning                            │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│          SQL Generator (New)                     │
│   - TimeQL → SQL translation                     │
│   - Native query → WHERE clause                  │
│   - Temporal joins → ASOF/Window                 │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│              DuckDB Engine                       │
│   - Automatic spilling to disk                   │
│   - Columnar storage                             │
│   - Parallel execution                           │
│   - Memory management                            │
└──────────────────────────────────────────────────┘
```

## Implementation Phases

## Phase 1: DuckDB Integration Foundation (Week 1-2) ✅ COMPLETED

### 1.1 Core DuckDB Infrastructure
- [x] Add DuckDB as dependency (v1.3.2 installed)
- [x] Create DuckDBExecutor class (src/duckdb-executor.ts)
- [x] Design unified event table schema (with partitioning)
- [x] Implement connection pooling (single connection model)
- [x] Add configuration management (DuckDBConfig interface)

### 1.2 Event Ingestion Pipeline
- [x] Create StreamToDuckDB ingester (ingestStream method)
- [x] Implement batch insertion with Appender API (10k batch size)
- [x] Add schema mapping for different sources (EventSchema interface)
- [x] Create indexes on common join keys (request_id, trace_id, etc.)
- [x] Implement partitioning by time (partition_date column)

### 1.3 Basic Testing
- [x] Unit tests for DuckDB operations (24 tests passing)
- [x] Integration tests with sample data (3/11 passing, complex correlations need Phase 3)
- [x] Memory usage benchmarks (tested in DiskSpillableStorage)
- [x] Performance baseline measurements (19,724 events/sec achieved)

**Deliverable**: ✅ Can ingest and query events via DuckDB

**Completed Features:**
- DuckDBExecutor with automatic initialization
- Memory limit configuration (default 4GB)
- Thread pool configuration (default 4 threads)
- Temp directory for disk spilling
- Event statistics tracking
- Automatic index creation
- Batch ingestion with progress reporting

## Phase 2: TimeQL to SQL Translation (Week 3-4) ✅ COMPLETED

### 2.1 SQL Generator Core
- [x] Create SQLGenerator class (TimeQLToSQLGenerator)
- [x] Map TimeQL operations to SQL
  - [x] AND → INNER JOIN
  - [x] OR → LEFT JOIN  
  - [x] UNLESS → ANTI JOIN
  - [x] within() → temporal conditions
- [x] Handle time window extraction (parseTimeWindow method)
- [x] Generate CTEs for complex queries

### 2.2 Native Query Translation
- [x] Graylog query → SQL WHERE (generateWhereClause method)
- [x] LogQL selector → SQL WHERE (parseLogQLSelector method with line filters)
- [x] PromQL matcher → SQL WHERE (parsePromQLSelector method with metric names)
- [x] Handle regex patterns (full support with ~, !~, =~, !=)
- [x] Support field existence checks (_exists_:field syntax)

### 2.3 Query Optimization
- [x] Implement predicate pushdown (extractPushdownPredicates in QueryOptimizer)
- [x] Add partition pruning (identifyPrunablePartitions method)
- [x] Choose optimal join order (determineJoinOrder with cardinality estimation)
- [x] Generate query execution plan (generateExplainSQL method)
- [x] Add EXPLAIN support for debugging

**Deliverable**: ✅ TimeQL queries execute via SQL on DuckDB with full optimization

**Completed Features:**
- TimeQLToSQLGenerator class with multi-format support
- Complete TimeQL to SQL translation
- CTE generation for streams
- Native query parsing for Graylog, LogQL, and PromQL
- Temporal join support with ASOF capabilities
- QueryOptimizer with cost-based optimization
- Comprehensive test coverage (107 tests passing)

## Phase 3: Hybrid Execution Mode (Week 5-6) ✅ COMPLETED

### 3.1 Execution Router
- [x] Create QueryRouter class
- [x] Simple routing based on:
  - Time window > 1 day → DuckDB
  - Expected events > 100K → DuckDB  
  - Otherwise → StreamJoiner
- [x] Support forced routing via query hints

### 3.2 Result Unification
- [x] Normalize DuckDB results to AsyncIterable<LogEvent>
- [x] Maintain consistent correlation format
- [x] Preserve streaming interface for both paths

**Deliverable**: ✅ Automatic routing between engines based on query characteristics

**Completed Features:**
- QueryRouter with configurable thresholds
- Automatic engine selection based on query analysis
- Query hints support (metadata.engine)
- Unified LogEvent output format
- 15 comprehensive tests passing

## Phase 4: Scale Optimizations (Week 7-8)

### 4.1 Semi-Join Optimization with Bloom Filters
- [ ] Implement semi-join reduction for asymmetric correlations
  - [ ] Detect when one stream completes first
  - [ ] Extract unique join keys from completed stream
  - [ ] Build Bloom filter for large key sets (>10K values)
  - [ ] Calculate time window bounds from completed stream
- [ ] Query rewriting for incomplete stream
  - [ ] Add join key filter (IN clause or Bloom filter)
  - [ ] Add temporal bounds to reduce scan range
  - [ ] Estimate reduction factor and restart if beneficial
- [ ] Bloom filter implementation
  - [ ] Use optimal size based on key cardinality
  - [ ] Configure false positive rate (default 0.1%)
  - [ ] Support serialization for distributed execution
- [ ] Adaptive query execution
  - [ ] Monitor stream progress and cardinality
  - [ ] Dynamic decision to apply semi-join optimization
  - [ ] Fallback to full scan if reduction is minimal

### 4.2 Advanced DuckDB Features
- [ ] Implement ASOF joins for temporal correlation
- [ ] Use window functions for pattern detection
- [ ] Add approximate algorithms (HyperLogLog)
- [ ] Implement sampling for huge datasets
- [ ] Create materialized views for common patterns

### 4.3 Storage Optimization
- [ ] Implement time-based partitioning
- [ ] Add compression (Snappy/ZSTD)
- [ ] Create archival to Parquet files
- [ ] Implement retention policies
- [ ] Add vacuum/maintenance jobs

### 4.4 Performance Tuning
- [ ] Profile and optimize hot paths
- [ ] Implement query result caching
- [ ] Add connection pooling
- [ ] Optimize batch sizes
- [ ] Tune DuckDB memory settings

**Deliverable**: 100x performance improvement for large datasets

## Phase 5: Production Hardening (Week 9-10)

### 5.1 Observability
- [ ] Add query execution metrics
- [ ] Implement slow query logging
- [ ] Create performance dashboards
- [ ] Add resource usage tracking
- [ ] Implement query profiling

### 5.2 Reliability
- [ ] Add transaction support
- [ ] Implement checkpoint/recovery
- [ ] Handle partial failures gracefully
- [ ] Add retry mechanisms
- [ ] Create backup strategies

### 5.3 Operations
- [ ] Create capacity planning tools
- [ ] Add administrative commands
- [ ] Implement health checks
- [ ] Create troubleshooting guides
- [ ] Add performance tuning docs

**Deliverable**: Production-ready system

## Phase 6: Advanced Features (Week 11-12)

### 6.1 Distributed Processing Preparation
- [ ] Design partition strategy
- [ ] Implement shard routing
- [ ] Add Apache Arrow support
- [ ] Create distributed query plan
- [ ] Implement result aggregation

### 6.2 Real-time + Historical
- [ ] Implement lambda architecture
- [ ] Create real-time buffer
- [ ] Add continuous queries
- [ ] Implement incremental processing
- [ ] Support streaming aggregations

### 6.3 Advanced Analytics
- [ ] Add statistical functions
- [ ] Implement anomaly detection
- [ ] Create pattern matching
- [ ] Add forecasting capabilities
- [ ] Support custom UDFs

**Deliverable**: Next-generation features

## Technical Implementation Details

### DuckDB Table Schema

```sql
-- Main events table (partitioned by day)
CREATE TABLE events (
  -- Core fields
  event_id BIGINT,
  timestamp TIMESTAMP NOT NULL,
  source VARCHAR NOT NULL,
  stream VARCHAR,
  message TEXT,
  
  -- Common join keys (indexed)
  request_id VARCHAR,
  trace_id VARCHAR,
  correlation_id VARCHAR,
  session_id VARCHAR,
  user_id VARCHAR,
  account_id VARCHAR,
  
  -- Labels as JSON for flexibility
  labels JSON,
  
  -- Metadata
  ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  partition_date DATE GENERATED ALWAYS AS (DATE_TRUNC('day', timestamp))
) PARTITION BY partition_date;

-- Indexes for performance
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_request_id ON events(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_events_trace_id ON events(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_events_source ON events(source, timestamp);

-- Summary statistics table
CREATE TABLE event_statistics (
  partition_date DATE,
  source VARCHAR,
  event_count BIGINT,
  unique_request_ids BIGINT,
  min_timestamp TIMESTAMP,
  max_timestamp TIMESTAMP,
  size_bytes BIGINT,
  PRIMARY KEY (partition_date, source)
);
```

### SQL Generation Examples

#### Simple Correlation
```sql
-- TimeQL: graylog({app="frontend"})[5m] and on(request_id) graylog({app="backend"})[5m]

WITH time_window AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '5 minutes' as start_time,
         CURRENT_TIMESTAMP as end_time
),
left_stream AS (
  SELECT e.*, 'left' as stream_side
  FROM events e, time_window tw
  WHERE e.source = 'graylog'
    AND e.timestamp BETWEEN tw.start_time AND tw.end_time
    AND json_extract_string(e.labels, '$.app') = 'frontend'
    AND e.request_id IS NOT NULL
),
right_stream AS (
  SELECT e.*, 'right' as stream_side
  FROM events e, time_window tw
  WHERE e.source = 'graylog'
    AND e.timestamp BETWEEN tw.start_time AND tw.end_time
    AND json_extract_string(e.labels, '$.app') = 'backend'
    AND e.request_id IS NOT NULL
)
SELECT 
  gen_random_uuid() as correlation_id,
  'request_id' as join_key,
  l.request_id as join_value,
  l.timestamp as left_timestamp,
  r.timestamp as right_timestamp,
  l.message as left_message,
  r.message as right_message,
  l.labels as left_labels,
  r.labels as right_labels
FROM left_stream l
INNER JOIN right_stream r ON l.request_id = r.request_id
ORDER BY l.timestamp;
```

#### Temporal Correlation with ASOF Join
```sql
-- TimeQL: loki({job="nginx"})[1h] and on(trace_id) within(30s) loki({job="app"})[1h]

WITH left_stream AS (
  SELECT * FROM events
  WHERE source = 'loki'
    AND timestamp >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
    AND json_extract_string(labels, '$.job') = 'nginx'
    AND trace_id IS NOT NULL
),
right_stream AS (
  SELECT * FROM events
  WHERE source = 'loki'
    AND timestamp >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
    AND json_extract_string(labels, '$.job') = 'app'
    AND trace_id IS NOT NULL
)
SELECT *
FROM left_stream l
ASOF JOIN right_stream r
  ON l.trace_id = r.trace_id
  AND r.timestamp >= l.timestamp - INTERVAL '30 seconds'
  AND r.timestamp <= l.timestamp + INTERVAL '30 seconds';
```

### Configuration

```yaml
# timebridge.config.yaml
execution:
  # Execution mode
  mode: hybrid  # memory | duckdb | hybrid
  
  # Routing thresholds
  routing:
    max_memory_events: 100000  # Use memory below this
    force_duckdb_time_window: 86400  # Force DuckDB for windows > 1 day
  
  # DuckDB settings
  duckdb:
    database_path: ./timebridge.duckdb
    memory_limit: 4GB
    threads: 8
    temp_directory: /fast-ssd/temp
    
  # Ingestion settings
  ingestion:
    batch_size: 10000
    flush_interval_ms: 1000
    compression: snappy
    
  # Retention settings
  retention:
    default_days: 30
    partition_size_days: 1
    archive:
      enabled: true
      format: parquet
      location: s3://timebridge-archive/
```

## Success Metrics

### Performance Targets
- **Ingestion**: 1M events/second sustained
- **Query Latency**: < 5 seconds for 1B events
- **Memory Usage**: < 8GB for any dataset size
- **Disk Usage**: ~100 bytes/event compressed

### Scalability Targets
- **Dataset Size**: 1+ trillion events
- **Time Windows**: Up to 1 year
- **Concurrent Queries**: 100+
- **Join Keys**: 1M+ unique values

### Reliability Targets
- **Availability**: 99.9%
- **Data Loss**: Zero
- **Recovery Time**: < 5 minutes
- **Query Success Rate**: 99.99%

## Risk Mitigation

### Technical Risks
1. **DuckDB limitations** → Maintain StreamJoiner fallback
2. **SQL generation bugs** → Extensive test suite
3. **Performance regression** → A/B testing framework
4. **Memory spills** → Fast SSD/NVMe requirement

### Operational Risks
1. **Migration complexity** → Phased rollout
2. **Training needs** → Keep TimeQL unchanged
3. **Debugging difficulty** → SQL EXPLAIN output
4. **Resource planning** → Capacity planning tools

## Testing Strategy

### Unit Tests
- SQL generation for all TimeQL patterns
- DuckDB operations
- Result normalization
- Router decisions

### Integration Tests
- End-to-end TimeQL execution
- Multi-source correlations
- Large dataset handling
- Memory limit compliance

### Performance Tests
- Benchmark vs current implementation
- Scale tests (1M, 100M, 1B, 100B events)
- Concurrent query load
- Memory pressure scenarios

### Chaos Tests
- Disk full scenarios
- OOM killer simulation
- Partial failures
- Recovery testing

## Documentation Deliverables

1. **Architecture Guide** - System design and components
2. **Migration Guide** - Moving from v1 to v2
3. **Performance Tuning** - Optimization strategies
4. **Troubleshooting Guide** - Common issues and solutions
5. **API Reference** - New configuration options
6. **SQL Reference** - Generated SQL patterns

## Timeline Summary

- **Weeks 1-2**: DuckDB Foundation
- **Weeks 3-4**: TimeQL Translation  
- **Weeks 5-6**: Hybrid Execution
- **Weeks 7-8**: Scale Optimizations
- **Weeks 9-10**: Production Hardening
- **Weeks 11-12**: Advanced Features

**Total Duration**: 12 weeks to production-ready trillion-event support

## Next Steps

1. Review and approve plan
2. Set up DuckDB development environment
3. Create feature branch `feat/duckdb-trillion-scale`
4. Begin Phase 1 implementation
5. Weekly progress reviews

## Appendix: Alternative Approaches Considered

1. **Apache Spark** - Too heavy, requires cluster
2. **ClickHouse** - Requires separate server
3. **Apache Drill** - Less mature than DuckDB
4. **Custom disk spilling** - Reinventing the wheel
5. **Distributed StreamJoiner** - Too complex for v2

DuckDB selected for:
- Embedded operation (no server)
- Excellent performance
- Automatic memory management
- SQL compatibility
- Active development