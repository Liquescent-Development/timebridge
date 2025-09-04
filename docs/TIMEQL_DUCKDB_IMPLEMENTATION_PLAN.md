# TimeQL DuckDB Implementation Plan

## Overview

This implementation plan outlines the steps to enable TimeQL queries on persisted DuckDB data, following the designs in TIMEQL_DUCKDB_GRAMMAR.md and TIMEQL_DUCKDB_QUERIES.md.

## Phase 1: Foundation (Week 1)

### Grammar Extensions

- [x] **1.1** Extend TimeQL grammar to support database expressions
  - [x] Add `DatabaseExpr` rule for `events{...}[...]` syntax
  - [x] Add `LabelSelector` rules for Prometheus-style filters
  - [x] Add label operators (`=`, `!=`, `=~`, `!~`)
  - [x] Update `StreamExpr` to include `DatabaseExpr` as alternative
  - [x] Test grammar with sample queries

### Parser Updates

- [x] **1.2** Update TimeQL parser to handle new AST nodes
  - [x] Create `DatabaseQuery` type in types.ts
  - [x] Add `parseDatabaseQuery` method to parser
  - [x] Handle label selector parsing
  - [x] Add unit tests for database query parsing
  - [x] Ensure backward compatibility with existing queries

### SQL Generation Basics

- [x] **1.3** Extend TimeQLToSQLGenerator for database queries
  - [x] Add `generateDatabaseSQL` method
  - [x] Implement label filter to SQL WHERE clause conversion
  - [x] Handle time range filters
  - [x] Support JSON field extraction for labels
  - [x] Add SQL generation tests

## Phase 2: Persistence Layer (Week 1-2)

### DuckDB Executor Enhancements

- [x] **2.1** Add persistence capabilities to DuckDBExecutor
  - [x] Add `exportDatabase(path)` method
  - [x] Add `importDatabase(path)` method  
  - [x] Implement `persistToDisk()` with configurable path
  - [x] Add `loadFromDisk()` for loading persisted DBs
  - [x] Handle database versioning/metadata

### Query Executor Updates

- [x] **2.2** Modify QueryRouter to support persistence
  - [x] Add `persistData` configuration option
  - [x] Add `persistPath` configuration option
  - [x] Implement post-query persistence logic
  - [x] Add `isPersisted` state tracking
  - [x] Emit persistence events for monitoring

### Session Management

- [x] **2.3** Create DatabaseSessionManager
  - [x] Track active database sessions
  - [x] Implement session lifecycle (create/load/close)
  - [x] Add session metadata (created_at, last_accessed, size)
  - [x] Support multiple concurrent sessions
  - [x] Add cleanup for old sessions

## Phase 3: Query Interface (Week 2)

### Direct Query API

- [x] **3.1** Create TimeQLQueryClient class
  - [x] Constructor with database path/session options
  - [x] `query(timeql: string)` method for TimeQL queries
  - [x] `sql(query: string)` method for raw SQL
  - [x] `listDatabases()` to show available persisted DBs
  - [x] `loadDatabase(name)` to load specific DB
  - [x] `getMetadata()` for database info

### Query Execution Pipeline

- [x] **3.2** Implement query execution flow
  - [x] Parse TimeQL query
  - [x] Detect database vs streaming query
  - [x] Generate optimized SQL
  - [x] Execute against DuckDB
  - [x] Format results consistently
  - [x] Add query caching layer

### Error Handling

- [x] **3.3** Comprehensive error handling
  - [x] Database not found errors
  - [x] Invalid query syntax errors
  - [x] SQL generation failures
  - [x] DuckDB execution errors
  - [x] Helpful error messages with suggestions

## Phase 4: Aggregation Support (Week 2-3)

### Grammar for Aggregations

- [x] **4.1** Add aggregation rules to grammar
  - [x] Add `AggregationExpr` rule
  - [x] Support functions: sum, avg, min, max, count
  - [x] Add `GroupingClause` for "by(labels)"
  - [x] Support nested aggregations
  - [x] Test with complex aggregation queries

### Aggregation SQL Generation

- [x] **4.2** SQL generation for aggregations
  - [x] Map aggregation functions to SQL
  - [x] Handle GROUP BY clauses
  - [x] Support HAVING conditions
  - [x] Optimize for DuckDB columnar storage
  - [x] Add aggregation-specific tests

### Time-Series Functions

- [ ] **4.3** Implement rate/increase functions
  - [ ] Add rate() function support
  - [ ] Add increase() function support
  - [ ] Add delta() function support
  - [ ] Handle time window calculations
  - [ ] Ensure correct per-second calculations

## Phase 5: Advanced Features (Week 3-4)

### Pattern Matching

- [x] **5.1** Event sequence patterns
  - [x] Add pattern operators to grammar (follows, precedes)
  - [x] Implement pattern matching in SQL
  - [x] Support temporal constraints (within)
  - [x] Add pattern query examples
  - [x] Test with real-world patterns

### Multi-Stream Correlations

- [ ] **5.2** Complex join support
  - [ ] Three-way and N-way joins
  - [ ] Different join keys per stream
  - [ ] Temporal join windows
  - [ ] Join order optimization
  - [ ] Performance testing with large datasets

### Query Optimization

- [ ] **5.3** DuckDB-specific optimizations
  - [ ] Create indexes on common join keys
  - [ ] Implement query plan caching
  - [ ] Add statistics collection
  - [ ] Partition pruning for time ranges
  - [ ] Columnar projection pushdown

## Phase 6: Integration & Testing (Week 4)

### Integration Tests

- [ ] **6.1** End-to-end testing
  - [ ] Test data ingestion → persistence → query flow
  - [ ] Test all query types (direct, correlation, aggregation)
  - [ ] Performance benchmarks
  - [ ] Memory usage testing
  - [ ] Concurrent query testing

### Documentation

- [ ] **6.2** User documentation
  - [ ] API reference documentation
  - [ ] Query language guide with examples
  - [ ] Migration guide from streaming to persisted
  - [ ] Performance tuning guide
  - [ ] Troubleshooting guide

### Examples

- [ ] **6.3** Create example applications
  - [ ] Basic query examples
  - [ ] Complex correlation examples
  - [ ] Aggregation and analytics examples
  - [ ] Pattern detection examples
  - [ ] Performance comparison demos

## Phase 7: Production Readiness (Week 5)

### Database Management

- [ ] **7.1** Management utilities
  - [ ] Database backup/restore
  - [ ] Compaction and vacuum operations
  - [ ] Size monitoring and alerts
  - [ ] Automatic cleanup of old databases
  - [ ] Migration tools for schema changes

### Monitoring & Observability

- [ ] **7.2** Add monitoring capabilities
  - [ ] Query performance metrics
  - [ ] Database size metrics
  - [ ] Cache hit/miss rates
  - [ ] Error rate tracking
  - [ ] OpenTelemetry integration

### CLI Tool

- [x] **7.3** Create timeql CLI
  - [x] `timeql query <database> <query>` - Execute query
  - [x] `timeql list` - List databases
  - [x] `timeql info <database>` - Show metadata
  - [x] `timeql export <database>` - Export to file
  - [x] `timeql import <file>` - Import database
  - [x] `timeql repl <database>` - Interactive REPL

## Phase 8: Advanced Capabilities (Future)

### Distributed Query

- [ ] **8.1** Multi-database queries
  - [ ] Query federation across databases
  - [ ] Distributed join execution
  - [ ] Result aggregation
  - [ ] Load balancing
  - [ ] Failure handling

### Real-time + Historical

- [ ] **8.2** Hybrid queries
  - [ ] Combine persisted and streaming data
  - [ ] Seamless query syntax
  - [ ] Automatic data routing
  - [ ] Cache invalidation
  - [ ] Consistency guarantees

### Machine Learning

- [ ] **8.3** ML integration
  - [ ] Anomaly detection functions
  - [ ] Prediction functions
  - [ ] Pattern learning
  - [ ] Model training on historical data
  - [ ] Real-time scoring

## Success Criteria

### Performance Goals
- Query latency < 100ms for simple queries
- Support for 1B+ events in single database
- Aggregation queries < 1s on 100M events
- Concurrent query support (100+ simultaneous)

### Functionality Goals
- 100% TimeQL syntax compatibility
- All join types supported (inner, left, anti)
- Full aggregation function suite
- Pattern matching capabilities
- Zero data loss on persistence

### User Experience Goals
- Single-line query execution
- Clear error messages
- Comprehensive documentation
- Rich example library
- Active community support

## Development Timeline

```
Week 1: Foundation (Grammar, Parser, Basic SQL)
Week 2: Persistence & Query Interface
Week 3: Aggregations & Advanced Features
Week 4: Integration & Testing
Week 5: Production Readiness
Future: Advanced Capabilities
```

## Getting Started

1. **Set up development environment**
   ```bash
   cd packages/query-parser
   npm install
   npm run generate-parser  # Compile Peggy grammar
   npm test  # Run tests
   ```

2. **Start with grammar extensions**
   ```bash
   # Edit the grammar
   vim grammar/timeql.peggy
   
   # Add database expression rules
   # Test with sample queries
   npm run test:grammar
   ```

3. **Implement SQL generation**
   ```bash
   # Extend the SQL generator
   vim ../core/src/timeql-to-sql.ts
   
   # Add database SQL generation
   # Test with sample queries
   npm test
   ```

## Key Files to Modify

1. `/packages/query-parser/grammar/timeql.peggy` - Grammar definition
2. `/packages/query-parser/src/index.ts` - Parser implementation
3. `/packages/core/src/types.ts` - Type definitions
4. `/packages/core/src/timeql-to-sql.ts` - SQL generator
5. `/packages/core/src/duckdb-executor.ts` - DuckDB interface
6. `/packages/core/src/query-router.ts` - Query routing logic
7. `/packages/core/src/query-executor.ts` - Main query executor

## Testing Strategy

1. **Unit Tests** - Each component tested in isolation
2. **Integration Tests** - End-to-end query flow
3. **Performance Tests** - Benchmarks for large datasets
4. **Regression Tests** - Ensure backward compatibility
5. **Fuzz Testing** - Random query generation for edge cases

## Risk Mitigation

1. **Backward Compatibility** - All existing queries must continue working
2. **Performance Regression** - Benchmark before/after each change
3. **Data Loss** - Implement atomic persistence with rollback
4. **Query Complexity** - Start simple, add features incrementally
5. **User Adoption** - Provide migration guides and tooling

## Dependencies

- Peggy (parser generator) - Already installed
- DuckDB Node.js bindings - Already installed
- TypeScript - Already configured
- Jest (testing) - Already configured

## Next Steps

1. Review and approve this implementation plan
2. Create GitHub issues for each task
3. Set up feature branch for development
4. Begin with Phase 1 grammar extensions
5. Weekly progress reviews

This implementation plan provides a clear roadmap for adding TimeQL query support for persisted DuckDB data, with concrete tasks that can be tracked and completed incrementally.