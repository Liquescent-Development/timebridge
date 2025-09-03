export { TimeBridgeEngine } from "./correlation-engine";
export { TimeQLExecutor, query } from "./query-executor";
export { StreamJoiner } from "./stream-joiner";
export { MultiStreamJoiner } from "./multi-stream-joiner";
export { TimeWindow } from "./time-window";
export { BackpressureController } from "./backpressure-controller";
export { PerformanceMonitor } from "./performance-monitor";
export { EventDeduplicator } from "./event-deduplicator";
export { IndexedEventStore } from "./indexed-event-store";
export { ParallelProcessor } from "./parallel-processor";
export * from "./types";
// Export the new unified result helpers specifically
export { TimeQLResult, isEventResult, isCorrelationResult } from "./types";
export * from "./utils";

// DuckDB support for trillion-scale datasets
export { DuckDBExecutor } from "./duckdb-executor";
export type { DuckDBConfig, EventSchema } from "./duckdb-executor";
export { TimeQLToSQLGenerator } from "./timeql-to-sql";
export type { SQLGeneratorOptions } from "./timeql-to-sql";
export { DiskSpillableStorage } from "./disk-spillable-storage";
export { QueryOptimizer } from "./query-optimizer";
export type { OptimizationHints, SourceStatistics } from "./query-optimizer";
export { QueryRouter } from "./query-router";
export type { QueryRouterConfig, RoutingDecision } from "./query-router";

// Grafana support
export { 
  GrafanaDataSourceProxy,
  isGrafanaUrl 
} from "./grafana/grafana-datasource-proxy";
export type { 
  GrafanaProxyConfig,
  GrafanaDataSource,
  GrafanaQueryRequest,
  GrafanaQueryResponse 
} from "./grafana/grafana-datasource-proxy";

// Performance optimization
export { ConnectionPool } from "./grafana/connection-pool";
export type { ConnectionPoolOptions, ProxyConfig } from "./grafana/connection-pool";
export { CacheManager, DataSourceCache } from "./grafana/cache-manager";
export type { CacheOptions, CacheStats, CacheEntry } from "./grafana/cache-manager";
export { QueryBatcher, StreamOptimizer } from "./grafana/query-batcher";
export type { BatchOptions, BatchStats, QueuedQuery } from "./grafana/query-batcher";
