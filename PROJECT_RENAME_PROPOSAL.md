# Project Rename Proposal

## Current State

The project started as "log-correlator" but has evolved to support:

- **Logs**: Loki, Graylog
- **Metrics**: Prometheus (PromQL)
- **Time-Series**: InfluxDB (InfluxQL/Flux)

It now provides a unified correlation engine for observability data across different data sources and types.

## Naming Criteria

A good name should:

1. Reflect the expanded scope beyond just logs
2. Indicate the correlation/joining capability
3. Be memorable and professional
4. Be available as an npm package name
5. Suggest observability/monitoring use cases

## Proposed Names

### Top Candidates

#### 1. **Liquescent** (Current npm scope)

- **Full Name**: `liquescent` or `@liquescent/correlator`
- **Pros**:
  - Already using @liquescent scope
  - Suggests fluidity and flowing together (like data streams)
  - Unique and memorable
- **Cons**:
  - Not immediately obvious what it does
  - Abstract name

#### 2. **DataWeaver**

- **npm**: `@liquescent/data-weaver` or `data-weaver`
- **Pros**:
  - Suggests weaving together different data sources
  - Clear metaphor for correlation
  - Works for any data type
- **Cons**:
  - Generic "data" term

#### 3. **ObservaLink**

- **npm**: `@liquescent/observa-link` or `observa-link`
- **Pros**:
  - Clear observability focus
  - "Link" suggests correlation
  - Professional sounding
- **Cons**:
  - Might be too narrow for future expansion

#### 4. **StreamFusion**

- **npm**: `@liquescent/stream-fusion` or `stream-fusion`
- **Pros**:
  - Emphasizes streaming architecture
  - "Fusion" suggests joining/correlation
  - Tech-forward name
- **Cons**:
  - Could be confused with data streaming platforms

#### 5. **CorrelateX**

- **npm**: `@liquescent/correlatex` or `correlatex`
- **Pros**:
  - Clear correlation focus
  - "X" suggests multiple/cross-platform
  - Simple and direct
- **Cons**:
  - Similar to current name
  - "X" suffix is common

#### 6. **TelemetryBridge**

- **npm**: `@liquescent/telemetry-bridge` or `telemetry-bridge`
- **Pros**:
  - Telemetry covers logs, metrics, traces
  - Bridge metaphor for connection
  - Enterprise-friendly
- **Cons**:
  - Longer name
  - Might suggest traces which we don't support yet

#### 7. **UnifyQL**

- **npm**: `@liquescent/unifyql` or `unifyql`
- **Pros**:
  - Suggests unified query language
  - QL suffix familiar from SQL, GraphQL, PromQL
  - Short and memorable
- **Cons**:
  - Might suggest only query, not correlation

#### 8. **CrossFlow**

- **npm**: `@liquescent/crossflow` or `crossflow`
- **Pros**:
  - Cross-platform data flow
  - Simple, memorable
  - Suggests correlation across sources
- **Cons**:
  - Could be confused with workflow tools

### Alternative Categories

#### Technical/Descriptive

- MetricLogFusion
- ObservabilityCorrelator
- TimeSeriesJoiner
- DataStreamCorrelator

#### Abstract/Creative

- Nexus (connection point)
- Prism (refracting/combining light/data)
- Conduit (data pipeline)
- Tapestry (weaving together)

#### Acronyms

- TOLD (Time-series, Observability, Logs, Data correlator)
- MELT (Metrics, Events, Logs, Traces)
- COOL (Correlation Of Observability Logs)

## Recommendation

Based on the criteria and the project's evolution, I recommend:

### Primary Choice: **Liquescent**

Use the existing `@liquescent` scope but rebrand the packages:

- `@liquescent/core` (instead of log-correlator-core)
- `@liquescent/loki`
- `@liquescent/graylog`
- `@liquescent/prometheus`
- `@liquescent/influxdb`

**Tagline**: "Liquescent - Fluid Observability Data Correlation"

**Reasoning**:

1. Already own the npm scope
2. Unique and memorable brand
3. Allows future expansion
4. Professional appearance
5. The name suggests fluidity and merging, perfect for data correlation

### Secondary Choice: **DataWeaver**

If we want a more descriptive name:

- `@liquescent/data-weaver-core`
- Or standalone: `data-weaver`

**Tagline**: "DataWeaver - Weaving Together Your Observability Data"

## Implementation Plan

1. **Phase 1**: Internal refactoring

   - Update package names in package.json files
   - Update import statements
   - Update documentation

2. **Phase 2**: npm migration

   - Publish under new names
   - Add deprecation notice to old packages
   - Update GitHub repository name

3. **Phase 3**: Community transition
   - Blog post explaining the change
   - Migration guide for users
   - Support both names temporarily

## Decision Required

Please choose which direction you'd prefer:

1. Keep @liquescent scope, simplify package names
2. Choose a completely new name
3. Keep current naming (log-correlator) despite expanded scope
