import fetch, { RequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import { LogEvent, CorrelationError } from "../types";
import { ConnectionPool, ConnectionPoolOptions, ProxyConfig } from "./connection-pool";
import { CacheManager, DataSourceCache } from "./cache-manager";
import { QueryBatcher, BatchOptions, StreamOptimizer } from "./query-batcher";
import * as zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Configuration for Grafana data source proxy
 */
export interface GrafanaProxyConfig {
  /** Grafana instance URL */
  grafanaUrl: string;
  
  /** Authentication token (Bearer token or Basic auth) */
  authToken?: string;
  
  /** Basic auth credentials */
  basicAuth?: {
    username: string;
    password: string;
  };
  
  /** Data source name to use */
  datasourceName?: string;
  
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  
  /** Request timeout in milliseconds */
  timeout?: number;
  
  /** Maximum retry attempts */
  maxRetries?: number;
  
  /** SOCKS proxy configuration */
  proxy?: {
    host: string;
    port: number;
    type?: 4 | 5;
    username?: string;
    password?: string;
  };
  
  /** Grafana-specific options */
  grafanaOptions?: {
    /** Force refresh data source cache */
    refreshDataSources?: boolean;
    /** Data source cache TTL in milliseconds */
    datasourceCacheTTL?: number;
    /** Query timeout override */
    queryTimeout?: number;
  };
  
  /** Performance optimization options */
  optimization?: {
    /** Enable connection pooling */
    connectionPool?: boolean | ConnectionPoolOptions;
    /** Enable query batching */
    queryBatching?: boolean | BatchOptions;
    /** Enable response caching */
    caching?: boolean | { maxSize?: number; ttl?: number };
    /** Enable compression */
    compression?: boolean;
    /** Enable stream optimization */
    streamOptimization?: boolean;
  };
}

/**
 * Grafana data source information
 */
export interface GrafanaDataSource {
  id: number;
  uid: string;
  name: string;
  type: string;
  url?: string;
  database?: string;
  jsonData?: Record<string, any>;
  isDefault?: boolean;
  access?: string;
}

/**
 * Grafana query request format
 */
export interface GrafanaQueryRequest {
  queries: Array<{
    datasource: { uid: string };
    refId: string;
    [key: string]: any; // Query-specific fields
  }>;
  from: string;
  to: string;
}

/**
 * Grafana query response format
 */
export interface GrafanaQueryResponse {
  results: Record<string, {
    frames?: Array<{
      schema: {
        refId: string;
        fields: Array<{
          name: string;
          type: string;
          typeInfo?: Record<string, any>;
        }>;
      };
      data: {
        values: any[][];
      };
    }>;
    series?: any[];
    tables?: any[];
    error?: string;
  }>;
}

/**
 * Base class for Grafana data source proxy implementations
 * Handles authentication, data source discovery, and query proxying
 */
export abstract class GrafanaDataSourceProxy {
  protected config: GrafanaProxyConfig;
  protected proxyAgent?: SocksProxyAgent;
  protected dataSourceCache: Map<string, GrafanaDataSource> = new Map();
  protected dataSourceCacheTime = 0;
  protected dataSourceCacheTTL: number;
  protected isGrafanaInstance?: boolean;
  protected currentDataSource?: GrafanaDataSource;
  
  // Optimization components
  protected connectionPool?: ConnectionPool;
  protected queryBatcher?: QueryBatcher;
  protected cacheManager?: CacheManager;
  protected dataSourceCacheManager?: DataSourceCache;
  protected streamOptimizer?: StreamOptimizer;
  protected compressionEnabled: boolean;

  constructor(config: GrafanaProxyConfig) {
    this.config = {
      timeout: 30000,
      maxRetries: 3,
      ...config,
      grafanaOptions: {
        datasourceCacheTTL: 3600000, // 1 hour default
        ...config.grafanaOptions,
      },
    };

    this.dataSourceCacheTTL = this.config.grafanaOptions?.datasourceCacheTTL || 3600000;

    // Setup SOCKS proxy if configured
    if (this.config.proxy) {
      const { host, port, type = 5, username, password } = this.config.proxy;
      const auth = username && password ? `${username}:${password}@` : "";
      const proxyUrl = `socks${type}://${auth}${host}:${port}`;
      this.proxyAgent = new SocksProxyAgent(proxyUrl);
    }
    
    // Initialize optimizations
    this.initializeOptimizations();
    this.compressionEnabled = config.optimization?.compression !== false;
  }
  
  /**
   * Initialize performance optimization components
   */
  protected initializeOptimizations(): void {
    const opt = this.config.optimization || {};
    
    // Connection pooling
    if (opt.connectionPool !== false) {
      const poolOptions = typeof opt.connectionPool === "object" 
        ? opt.connectionPool 
        : { maxConnections: 50, maxConnectionsPerHost: 10 };
      
      const proxyConfig = this.config.proxy ? {
        host: this.config.proxy.host,
        port: this.config.proxy.port,
        auth: this.config.proxy.username && this.config.proxy.password ? {
          username: this.config.proxy.username,
          password: this.config.proxy.password,
        } : undefined,
      } : undefined;
      
      this.connectionPool = new ConnectionPool(poolOptions, proxyConfig);
    }
    
    // Query batching
    if (opt.queryBatching) {
      const batchOptions = typeof opt.queryBatching === "object"
        ? opt.queryBatching
        : { maxBatchSize: 10, batchTimeout: 100 };
      this.queryBatcher = new QueryBatcher(batchOptions);
    }
    
    // Response caching
    if (opt.caching !== false) {
      const cacheOptions = typeof opt.caching === "object"
        ? opt.caching
        : { maxSize: 50 * 1024 * 1024, ttl: 300000 }; // 50MB, 5 minutes
      
      this.cacheManager = new CacheManager({
        maxSize: cacheOptions.maxSize,
        defaultTTL: cacheOptions.ttl,
      });
      
      this.dataSourceCacheManager = new DataSourceCache();
    }
    
    // Stream optimization
    if (opt.streamOptimization !== false) {
      this.streamOptimizer = new StreamOptimizer(8192, this.compressionEnabled);
    }
  }

  /**
   * Get the data source type (e.g., 'prometheus', 'loki', 'influxdb')
   */
  abstract getDataSourceType(): string;

  /**
   * Transform native query to Grafana query format
   */
  abstract transformQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ): GrafanaQueryRequest;

  /**
   * Parse Grafana response to LogEvent stream
   */
  abstract parseResponse(response: GrafanaQueryResponse): AsyncIterable<LogEvent>;

  /**
   * Check if the given URL is a Grafana instance
   */
  async detectGrafana(url: string): Promise<boolean> {
    if (this.isGrafanaInstance !== undefined) {
      return this.isGrafanaInstance;
    }

    try {
      // Try to access Grafana API endpoint
      const response = await this.makeRequest("/api/health", {
        method: "GET",
        timeout: 5000, // Quick timeout for detection
      });

      // Check if response looks like Grafana
      if (response.ok) {
        const data = await response.text();
        this.isGrafanaInstance = data.includes("ok") || data.includes("database");
      } else if (response.status === 401 || response.status === 403) {
        // Authentication required - likely Grafana
        this.isGrafanaInstance = true;
      } else {
        this.isGrafanaInstance = false;
      }
    } catch (error) {
      // Try alternate detection - check for Grafana-specific endpoints
      try {
        const response = await this.makeRequest("/api/datasources", {
          method: "GET",
          timeout: 5000,
        });
        this.isGrafanaInstance = response.status === 401 || response.status === 403 || response.ok;
      } catch {
        this.isGrafanaInstance = false;
      }
    }

    return this.isGrafanaInstance || false;
  }

  /**
   * Discover and cache available data sources
   */
  async discoverDataSources(forceRefresh = false): Promise<Map<string, GrafanaDataSource>> {
    const now = Date.now();
    
    // Check cache validity
    if (!forceRefresh && 
        this.dataSourceCache.size > 0 && 
        (now - this.dataSourceCacheTime) < this.dataSourceCacheTTL) {
      return this.dataSourceCache;
    }

    try {
      const response = await this.makeRequest("/api/datasources", {
        method: "GET",
      });

      if (!response.ok) {
        throw new CorrelationError(
          `Failed to fetch data sources: ${response.statusText}`,
          "GRAFANA_DATASOURCE_FETCH_ERROR",
          { status: response.status }
        );
      }

      const dataSources: GrafanaDataSource[] = await response.json();
      
      // Clear and rebuild cache
      this.dataSourceCache.clear();
      
      // Filter for our data source type and build cache
      const targetType = this.getDataSourceType();
      for (const ds of dataSources) {
        if (ds.type === targetType || this.isCompatibleType(ds.type)) {
          this.dataSourceCache.set(ds.name, ds);
        }
      }

      this.dataSourceCacheTime = now;
      return this.dataSourceCache;
    } catch (error) {
      throw new CorrelationError(
        "Failed to discover Grafana data sources",
        "GRAFANA_DISCOVERY_ERROR",
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Check if a data source type is compatible
   */
  protected isCompatibleType(type: string): boolean {
    const targetType = this.getDataSourceType();
    const compatibilityMap: Record<string, string[]> = {
      prometheus: ["prometheus", "prometheus-datasource", "camptocamp-prometheus"],
      loki: ["loki", "loki-datasource", "grafana-loki"],
      influxdb: ["influxdb", "influxdb-datasource", "influxdb-08", "influxdb-flux"],
    };

    return compatibilityMap[targetType]?.includes(type) || false;
  }

  /**
   * Resolve data source name to UID
   */
  async resolveDataSource(name?: string): Promise<GrafanaDataSource> {
    // If already resolved, return it
    if (this.currentDataSource && (!name || this.currentDataSource.name === name)) {
      return this.currentDataSource;
    }

    // Discover available data sources
    const dataSources = await this.discoverDataSources();

    if (dataSources.size === 0) {
      throw new CorrelationError(
        `No ${this.getDataSourceType()} data sources found in Grafana`,
        "GRAFANA_NO_DATASOURCES",
        { type: this.getDataSourceType() }
      );
    }

    // If name provided, look for exact match
    if (name) {
      const dataSource = dataSources.get(name);
      if (dataSource) {
        this.currentDataSource = dataSource;
        return dataSource;
      }

      // Try case-insensitive match
      for (const [dsName, ds] of dataSources) {
        if (dsName.toLowerCase() === name.toLowerCase()) {
          this.currentDataSource = ds;
          return ds;
        }
      }

      throw new CorrelationError(
        `Data source '${name}' not found in Grafana`,
        "GRAFANA_DATASOURCE_NOT_FOUND",
        { 
          requestedName: name,
          availableNames: Array.from(dataSources.keys())
        }
      );
    }

    // No name provided - use first compatible data source or default
    let defaultDs: GrafanaDataSource | undefined;
    let firstDs: GrafanaDataSource | undefined;

    for (const ds of dataSources.values()) {
      if (!firstDs) firstDs = ds;
      if (ds.isDefault) {
        defaultDs = ds;
        break;
      }
    }

    const selected = defaultDs || firstDs;
    if (!selected) {
      throw new CorrelationError(
        `No compatible ${this.getDataSourceType()} data source found`,
        "GRAFANA_NO_COMPATIBLE_DATASOURCE",
        { type: this.getDataSourceType() }
      );
    }

    this.currentDataSource = selected;
    return selected;
  }

  /**
   * Execute a query through Grafana
   */
  async executeQuery(
    query: string,
    timeRange: { from: Date; to: Date },
    options?: any
  ): Promise<AsyncIterable<LogEvent>> {
    // Check cache first
    const cacheKey = `${query}_${timeRange.from.getTime()}_${timeRange.to.getTime()}_${JSON.stringify(options || {})}`;
    
    if (this.cacheManager) {
      const cached = this.cacheManager.get(cacheKey);
      if (cached) {
        // Return cached results as async iterable
        return (async function* () {
          yield* cached as AsyncIterable<LogEvent>;
        })();
      }
    }
    
    // Resolve data source
    const dataSource = await this.resolveDataSource(this.config.datasourceName);

    // Convert time range to Grafana format
    const grafanaTimeRange = {
      from: this.formatTime(timeRange.from),
      to: this.formatTime(timeRange.to),
    };

    // Transform query to Grafana format
    const queryRequest = this.transformQuery(
      query,
      dataSource.uid,
      grafanaTimeRange,
      options
    );

    // Use query batcher if available
    let responseData: any;
    if (this.queryBatcher) {
      responseData = await this.queryBatcher.addQuery(queryRequest);
    } else {
      // Execute query directly
      const response = await this.makeRequest("/api/ds/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(queryRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new CorrelationError(
          `Grafana query failed: ${response.statusText}`,
        "GRAFANA_QUERY_ERROR",
        { 
          status: response.status,
          error: errorText,
          query,
          dataSource: dataSource.name
        }
      );
      }
      
      // Handle compressed response
      if ((response as any)._decompressedBody) {
        responseData = JSON.parse((response as any)._decompressedBody);
      } else {
        responseData = await response.json();
      }
    }

    const result: GrafanaQueryResponse = responseData;
    
    // Check for query errors
    for (const [refId, data] of Object.entries(result.results)) {
      if (data.error) {
        throw new CorrelationError(
          `Query error: ${data.error}`,
          "GRAFANA_QUERY_RESULT_ERROR",
          { 
            refId,
            error: data.error,
            query,
            dataSource: dataSource.name
          }
        );
      }
    }

    // Parse response
    const events = this.parseResponse(result);
    
    // Apply stream optimization if enabled
    let optimizedEvents = events;
    if (this.streamOptimizer) {
      optimizedEvents = this.streamOptimizer.optimize(events);
    }
    
    // Cache results if caching is enabled
    if (this.cacheManager) {
      const eventArray: LogEvent[] = [];
      const cacheManager = this.cacheManager;
      
      // Create caching stream that stores results after consumption
      async function* cachingStream() {
        for await (const event of optimizedEvents) {
          eventArray.push(event);
          yield event;
        }
        // Store in cache after stream is fully consumed
        if (eventArray.length > 0) {
          cacheManager.set(cacheKey, eventArray, 300000); // 5 minutes TTL
        }
      }
      
      return cachingStream();
    }
    
    return optimizedEvents;
  }

  /**
   * Make an authenticated HTTP request to Grafana
   */
  protected async makeRequest(
    path: string,
    options: RequestInit & { timeout?: number } = {}
  ): Promise<any> {
    const url = `${this.config.grafanaUrl}${path}`;
    const hostname = new URL(url).hostname;
    
    // Build headers
    const headers: Record<string, string> = {
      ...this.config.headers,
      ...options.headers as Record<string, string>,
    };

    // Add authentication
    if (this.config.authToken) {
      if (this.config.authToken.toLowerCase().startsWith("bearer ")) {
        headers["Authorization"] = this.config.authToken;
      } else {
        headers["Authorization"] = `Bearer ${this.config.authToken}`;
      }
    } else if (this.config.basicAuth) {
      const encoded = Buffer.from(
        `${this.config.basicAuth.username}:${this.config.basicAuth.password}`
      ).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
    }
    
    // Enable compression
    if (this.compressionEnabled) {
      headers["Accept-Encoding"] = "gzip, deflate";
      
      // Compress request body if present
      if (options.body && typeof options.body === "string") {
        const compressed = await gzip(Buffer.from(options.body));
        options.body = compressed;
        headers["Content-Encoding"] = "gzip";
      }
    }
    
    // Get agent from connection pool if available
    const agent = this.connectionPool 
      ? this.connectionPool.getAgent(url)
      : this.proxyAgent;

    // Prepare request options
    const fetchOptions: RequestInit = {
      ...options,
      headers,
      agent: agent as any,
      timeout: options.timeout || this.config.timeout,
    };
    
    // Acquire connection from pool
    if (this.connectionPool) {
      await this.connectionPool.acquireConnection(hostname);
    }

    try {
      // Execute request with retries
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= (this.config.maxRetries || 3); attempt++) {
        try {
          const response = await fetch(url, fetchOptions as any);
          
          // Handle compressed response
          if (this.compressionEnabled && response.headers.get("content-encoding")?.includes("gzip")) {
            const buffer = await response.buffer();
            const decompressed = await gunzip(buffer);
            // Create a new response-like object with decompressed data
            (response as any)._decompressedBody = decompressed.toString();
          }
          
          return response;
        } catch (error) {
          lastError = error as Error;
          
          // Don't retry on certain errors
          if (error instanceof Error && 
              (error.message.includes("ENOTFOUND") || 
               error.message.includes("ECONNREFUSED"))) {
            break;
          }

          // Wait before retry (exponential backoff)
          if (attempt < (this.config.maxRetries || 3)) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
        }
      }
      
      throw new CorrelationError(
        `Request to Grafana failed: ${lastError?.message}`,
        "GRAFANA_REQUEST_ERROR",
        { 
          url,
          error: lastError?.message
        }
      );
    } finally {
      // Release connection
      if (this.connectionPool) {
        this.connectionPool.releaseConnection(hostname);
      }
    }
  }

  /**
   * Format time for Grafana API
   */
  protected formatTime(date: Date): string {
    // Grafana accepts multiple formats:
    // - Epoch milliseconds: "1234567890000"
    // - Relative: "now-1h"
    // - ISO 8601: "2023-01-01T00:00:00Z"
    // We'll use epoch milliseconds for precision
    return date.getTime().toString();
  }

  /**
   * Check if this instance is connected to Grafana
   */
  isGrafana(): boolean {
    return this.isGrafanaInstance === true;
  }

  /**
   * Get current data source info
   */
  getCurrentDataSource(): GrafanaDataSource | undefined {
    return this.currentDataSource;
  }

  /**
   * Clear cached data
   */
  clearCache(): void {
    this.dataSourceCache.clear();
    this.dataSourceCacheTime = 0;
    this.currentDataSource = undefined;
    this.isGrafanaInstance = undefined;
    
    // Clear optimization caches
    if (this.cacheManager) {
      this.cacheManager.clear();
    }
    if (this.dataSourceCacheManager) {
      this.dataSourceCacheManager.clear();
    }
  }
  
  /**
   * Get performance statistics
   */
  getPerformanceStats(): {
    connectionPool?: any;
    queryBatcher?: any;
    cache?: any;
    dataSourceCache?: any;
  } {
    const stats: any = {};
    
    if (this.connectionPool) {
      stats.connectionPool = this.connectionPool.getStats();
    }
    
    if (this.queryBatcher) {
      stats.queryBatcher = this.queryBatcher.getStats();
    }
    
    if (this.cacheManager) {
      stats.cache = this.cacheManager.getStats();
    }
    
    if (this.dataSourceCacheManager) {
      stats.dataSourceCache = this.dataSourceCacheManager.getStats();
    }
    
    return stats;
  }
  
  /**
   * Invalidate cache entries
   */
  invalidateCache(pattern?: string | RegExp): number {
    let invalidated = 0;
    
    if (this.cacheManager && pattern) {
      invalidated += this.cacheManager.invalidate(pattern);
    } else if (this.cacheManager) {
      this.cacheManager.clear();
      invalidated = this.cacheManager.getStats().entries;
    }
    
    return invalidated;
  }
  
  /**
   * Destroy the proxy and clean up resources
   */
  destroy(): void {
    if (this.connectionPool) {
      this.connectionPool.destroy();
    }
    
    if (this.queryBatcher) {
      this.queryBatcher.destroy();
    }
    
    if (this.cacheManager) {
      this.cacheManager.destroy();
    }
    
    if (this.dataSourceCacheManager) {
      this.dataSourceCacheManager.destroy();
    }
    
    this.clearCache();
  }
}

/**
 * Helper function to detect if a URL points to a Grafana instance
 */
export async function isGrafanaUrl(url: string, authToken?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["Authorization"] = authToken.startsWith("Bearer ") 
        ? authToken 
        : `Bearer ${authToken}`;
    }

    // Quick check for Grafana API
    const response = await fetch(`${url}/api/health`, {
      method: "GET",
      headers,
      timeout: 5000 as any,
    });

    return response.ok || response.status === 401 || response.status === 403;
  } catch {
    // Try alternate endpoint
    try {
      const response = await fetch(`${url}/api/datasources`, {
        method: "GET",
        timeout: 5000 as any,
      });
      return response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }
}