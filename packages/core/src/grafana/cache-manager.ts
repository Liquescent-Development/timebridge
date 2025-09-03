import { EventEmitter } from "events";

export interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
  hits: number;
  size: number;
}

export interface CacheOptions {
  maxSize?: number; // Maximum cache size in bytes
  defaultTTL?: number; // Default TTL in milliseconds
  checkInterval?: number; // Interval for cleaning expired entries
  maxEntries?: number; // Maximum number of entries
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  entries: number;
  hitRate: number;
  evictions: number;
}

/**
 * Enhanced cache manager with TTL, size limits, and LRU eviction
 */
export class CacheManager<T = any> extends EventEmitter {
  private cache: Map<string, CacheEntry<T>>;
  private stats: CacheStats;
  private options: Required<CacheOptions>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private accessOrder: string[];

  constructor(options: CacheOptions = {}) {
    super();
    
    this.options = {
      maxSize: 100 * 1024 * 1024, // 100MB default
      defaultTTL: 3600000, // 1 hour default
      checkInterval: 60000, // Check every minute
      maxEntries: 10000,
      ...options,
    };

    this.cache = new Map();
    this.accessOrder = [];
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      entries: 0,
      hitRate: 0,
      evictions: 0,
    };

    // Start cleanup timer
    this.startCleanup();
  }

  /**
   * Get a value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      this.delete(key);
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Update access order for LRU
    this.updateAccessOrder(key);
    
    // Update stats
    entry.hits++;
    this.stats.hits++;
    this.updateHitRate();

    return entry.value;
  }

  /**
   * Set a value in cache
   */
  set(key: string, value: T, ttl?: number): void {
    const size = this.estimateSize(value);
    const effectiveTTL = ttl || this.options.defaultTTL;

    // Check if we need to evict entries
    this.ensureSpace(size);

    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      ttl: effectiveTTL,
      hits: 0,
      size,
    };

    // Remove old entry if exists
    if (this.cache.has(key)) {
      const oldEntry = this.cache.get(key)!;
      this.stats.size -= oldEntry.size;
      this.stats.entries--;
    }

    this.cache.set(key, entry);
    this.updateAccessOrder(key);
    
    this.stats.size += size;
    this.stats.entries++;

    this.emit("set", key, value);
  }

  /**
   * Delete a value from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.removeFromAccessOrder(key);
    
    this.stats.size -= entry.size;
    this.stats.entries--;

    this.emit("delete", key);
    return true;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.stats.size = 0;
    this.stats.entries = 0;
    this.emit("clear");
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (this.isExpired(entry)) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Invalidate entries matching a pattern
   */
  invalidate(pattern: string | RegExp): number {
    let count = 0;
    const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.delete(key);
        count++;
      }
    }

    this.emit("invalidate", pattern, count);
    return count;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get cache size information
   */
  getSizeInfo(): {
    used: number;
    max: number;
    percentage: number;
  } {
    return {
      used: this.stats.size,
      max: this.options.maxSize,
      percentage: (this.stats.size / this.options.maxSize) * 100,
    };
  }

  /**
   * Prewarm cache with multiple entries
   */
  async prewarm(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    for (const { key, value, ttl } of entries) {
      this.set(key, value, ttl);
    }
    this.emit("prewarm", entries.length);
  }

  /**
   * Check if an entry is expired
   */
  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  /**
   * Estimate size of a value
   */
  private estimateSize(value: T): number {
    if (typeof value === "string") {
      return value.length * 2; // Approximate bytes for UTF-16
    }
    
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024; // Default size if serialization fails
    }
  }

  /**
   * Ensure there's space for new entry
   */
  private ensureSpace(requiredSize: number): void {
    // Check entry count limit
    while (this.cache.size >= this.options.maxEntries && this.accessOrder.length > 0) {
      this.evictLRU();
    }

    // Check size limit
    while (this.stats.size + requiredSize > this.options.maxSize && this.accessOrder.length > 0) {
      this.evictLRU();
    }
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    const key = this.accessOrder.shift()!;
    if (this.cache.has(key)) {
      this.delete(key);
      this.stats.evictions++;
      this.emit("evict", key);
    }
  }

  /**
   * Update access order for LRU tracking
   */
  private updateAccessOrder(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  /**
   * Remove key from access order
   */
  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Update hit rate statistic
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Start cleanup timer
   */
  private startCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.options.checkInterval);
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.emit("cleanup", cleaned);
    }
  }

  /**
   * Destroy the cache manager
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    
    this.clear();
    this.removeAllListeners();
  }
}

/**
 * Create a specialized cache for data sources
 */
export class DataSourceCache extends CacheManager<any> {
  constructor() {
    super({
      defaultTTL: 3600000, // 1 hour
      maxEntries: 100,
      maxSize: 10 * 1024 * 1024, // 10MB
    });
  }

  /**
   * Cache a data source with automatic key generation
   */
  cacheDataSource(grafanaUrl: string, name: string, dataSource: any): void {
    const key = this.generateKey(grafanaUrl, name);
    this.set(key, dataSource);
  }

  /**
   * Get a cached data source
   */
  getDataSource(grafanaUrl: string, name: string): any {
    const key = this.generateKey(grafanaUrl, name);
    return this.get(key);
  }

  /**
   * Invalidate all data sources for a Grafana instance
   */
  invalidateInstance(grafanaUrl: string): number {
    const pattern = `^${this.escapeRegex(grafanaUrl)}:`;
    return this.invalidate(new RegExp(pattern));
  }

  /**
   * Generate cache key for data source
   */
  private generateKey(grafanaUrl: string, name: string): string {
    return `${grafanaUrl}:${name}`;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}