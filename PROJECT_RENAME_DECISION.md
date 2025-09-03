# Project Rename: TimeBridge

## Final Decision

**New Name**: **TimeBridge**  
**Query Language**: **TimeQL**  
**npm Scope**: `@timebridge`  
**Tagline**: "TimeBridge - Bridging Observability Data Across Time"

## Rationale

1. **Primary Consumer**: TimeBuddy (time series IDE) will be the first consumer, making the time-series focus appropriate
2. **Clear Purpose**: "Bridge" immediately conveys the connection/correlation aspect
3. **Time-Centric**: All observability data (logs, metrics, traces) is fundamentally time-based
4. **Professional**: Enterprise-friendly naming that's descriptive yet concise
5. **Query Language**: TimeQL follows established patterns (SQL, GraphQL, PromQL) and is intuitive

## Package Structure

### Current Structure

```
@liquescent/log-correlator-core
@liquescent/log-correlator-loki
@liquescent/log-correlator-graylog
@liquescent/log-correlator-prometheus
@liquescent/log-correlator-influxdb
@liquescent/log-correlator-query-parser
```

### New Structure

```
@timebridge/core
@timebridge/loki
@timebridge/graylog
@timebridge/prometheus
@timebridge/influxdb
@timebridge/timeql-parser
```

## Implementation Plan

### Phase 1: Preparation (Current)

- [x] Create new adapters (Prometheus, InfluxDB)
- [x] Document expanded capabilities
- [ ] Register @timebridge npm scope
- [ ] Update internal code references

### Phase 2: Code Migration

1. Update all package.json files with new names
2. Update all import statements to use @timebridge
3. Rename query parser to timeql-parser
4. Update class names where appropriate:
   - `CorrelationEngine` → `TimeBridge` or `TimeBridgeEngine`
   - `QueryExecutor` → `TimeQLExecutor`
   - Keep adapter names unchanged

### Phase 3: Documentation Updates

1. Update all README files
2. Create migration guide from @liquescent to @timebridge
3. Update examples to use new package names
4. Add TimeQL language specification document

### Phase 4: Publishing

1. Publish all packages under @timebridge scope
2. Mark @liquescent packages as deprecated with migration notice
3. Update GitHub repository name to `timebridge`
4. Create announcement for the rename

## TimeQL Language Specification

TimeQL extends the existing PromQL-inspired syntax with time-focused operations:

### Core Syntax

```timeql
SOURCE(SELECTOR)[TIME_RANGE] [OPERATOR] SOURCE(SELECTOR)[TIME_RANGE]
```

### Examples

```timeql
# Direct query
graylog(level:error)[5m]

# Time-based correlation
prometheus(cpu > 80)[10m]
  and on(host) within(30s)
graylog(level:error)[10m]

# Multi-source time alignment
influxdb(SELECT * FROM metrics)[1h]
  align on(timestamp)
prometheus(up)[1h]
```

### Future TimeQL Extensions

- `before(duration)` - Events before a time window
- `after(duration)` - Events after a time window
- `during(start, end)` - Events within specific time range
- `align on(timestamp)` - Align events by timestamp
- `timedelta(field)` - Calculate time differences
- `timeshift(duration)` - Shift time windows for comparison

## Integration with TimeBuddy

TimeBuddy will be able to:

1. Use TimeQL for unified queries across data sources
2. Visualize correlated time-series data from multiple sources
3. Create time-based alerts using TimeQL expressions
4. Store and replay TimeQL queries for analysis

## Migration Guide for Users

### For npm Users

```bash
# Old installation
npm uninstall @liquescent/log-correlator-core
npm uninstall @liquescent/log-correlator-loki

# New installation
npm install @timebridge/core
npm install @timebridge/loki
```

### For Code Updates

```javascript
// Old imports
const { QueryExecutor } = require("@liquescent/log-correlator-core");
const { LokiAdapter } = require("@liquescent/log-correlator-loki");

// New imports
const { TimeQLExecutor } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");

// Old usage
const executor = new QueryExecutor();

// New usage
const executor = new TimeQLExecutor();
```

## Benefits for TimeBuddy

1. **Native Integration**: Purpose-built for time-series analysis
2. **Unified Query Language**: Single query language (TimeQL) for all data sources
3. **Time-Centric Operations**: Built-in time alignment and correlation
4. **Extensible**: Easy to add new time-series data sources
5. **Performance**: Optimized for time-based queries and streaming

## Timeline

- **Week 1**: Register npm scope, prepare codebase
- **Week 2**: Implement rename, update documentation
- **Week 3**: Testing and validation
- **Week 4**: Publish under new name, deprecate old packages

## Action Items

- [ ] Register @timebridge npm organization
- [ ] Create timebridge GitHub repository
- [ ] Update all package references
- [ ] Write TimeQL specification document
- [ ] Create TimeBuddy integration examples
- [ ] Announce rename to community

## Conclusion

TimeBridge with TimeQL provides a clear, professional identity that:

- Aligns perfectly with TimeBuddy's needs
- Clearly communicates the time-series focus
- Maintains the correlation/bridging concept
- Sets up for future growth in the observability space
