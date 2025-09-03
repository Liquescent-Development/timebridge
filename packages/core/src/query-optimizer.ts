import { ParsedQuery } from './types';

export interface OptimizationHints {
  /**
   * Estimated number of events in the query result
   */
  estimatedEvents?: number;
  
  /**
   * Whether to use approximate algorithms
   */
  useApproximate?: boolean;
  
  /**
   * Partitions that can be pruned
   */
  prunedPartitions?: string[];
  
  /**
   * Suggested join order for multi-stream queries
   */
  joinOrder?: string[];
  
  /**
   * Predicates that can be pushed down to data source
   */
  pushdownPredicates?: string[];
}

/**
 * Query optimizer for TimeQL queries
 * Analyzes queries and provides optimization hints for execution
 */
export class QueryOptimizer {
  constructor(
    private statistics: Map<string, SourceStatistics> = new Map()
  ) {}

  /**
   * Analyze a query and generate optimization hints
   */
  optimize(query: ParsedQuery): OptimizationHints {
    const hints: OptimizationHints = {};
    
    // Estimate result size
    hints.estimatedEvents = this.estimateResultSize(query);
    
    // Determine if approximate algorithms should be used
    if (hints.estimatedEvents && hints.estimatedEvents > 1000000) {
      hints.useApproximate = true;
    }
    
    // Identify partitions to prune
    hints.prunedPartitions = this.identifyPrunablePartitions(query);
    
    // Determine optimal join order
    hints.joinOrder = this.determineJoinOrder(query);
    
    // Extract pushdown predicates
    hints.pushdownPredicates = this.extractPushdownPredicates(query);
    
    return hints;
  }

  /**
   * Estimate the number of events in the result
   */
  private estimateResultSize(query: ParsedQuery): number {
    // Get statistics for sources
    const leftStats = this.statistics.get(query.leftStream.source);
    const rightStats = query.rightStream ? this.statistics.get(query.rightStream.source) : undefined;
    
    if (!leftStats) return 0;
    
    // Estimate based on time window
    const timeWindowMs = this.parseTimeWindow(query.leftStream.timeRange || '5m');
    const timeWindowHours = timeWindowMs / (1000 * 60 * 60);
    
    // Estimate events per hour
    const eventsPerHour = leftStats.totalEvents / (leftStats.timeRangeHours || 1);
    let estimate = eventsPerHour * timeWindowHours;
    
    // For very large time windows, scale up the estimate
    if (timeWindowHours > 24) {
      estimate = estimate * 2; // Account for potential data growth
    }
    
    // Apply selectivity estimates for filters
    if (query.leftStream.selector) {
      // Rough selectivity estimate based on number of conditions
      const conditions = query.leftStream.selector.split(',').length;
      estimate *= Math.pow(0.5, conditions); // Each condition reduces by 50%
    }
    
    // For joins, estimate based on join selectivity
    if (rightStats) {
      const rightEstimate = (rightStats.totalEvents / (rightStats.timeRangeHours || 1)) * timeWindowHours;
      
      // Estimate join selectivity based on join type
      switch (query.joinType) {
        case 'and':
        case 'inner':
          // Inner join typically has low selectivity
          estimate = Math.min(estimate, rightEstimate) * 0.1;
          break;
        case 'or':
        case 'left':
          // Left join keeps all left events
          break;
        case 'unless':
        case 'anti':
          // Anti-join typically filters out 10-50% of events
          estimate *= 0.7;
          break;
      }
    }
    
    return Math.round(estimate);
  }

  /**
   * Identify partitions that can be pruned based on time range
   */
  private identifyPrunablePartitions(query: ParsedQuery): string[] {
    const prunedPartitions: string[] = [];
    
    // Parse time range
    const timeRange = query.leftStream.timeRange || query.timeWindow;
    if (!timeRange) return prunedPartitions;
    
    const timeWindowMs = this.parseTimeWindow(timeRange);
    const now = new Date();
    const startTime = new Date(now.getTime() - timeWindowMs);
    
    // Generate list of partition dates that are outside the time range
    const currentDate = new Date();
    for (let i = 30; i >= 0; i--) {
      const partitionDate = new Date(currentDate);
      partitionDate.setDate(partitionDate.getDate() - i);
      
      if (partitionDate < startTime) {
        prunedPartitions.push(partitionDate.toISOString().split('T')[0]);
      }
    }
    
    return prunedPartitions;
  }

  /**
   * Determine optimal join order for multi-stream queries
   */
  private determineJoinOrder(query: ParsedQuery): string[] {
    const streams = [query.leftStream, query.rightStream];
    if (query.additionalStreams) {
      streams.push(...query.additionalStreams);
    }
    
    // Filter out undefined streams
    const validStreams = streams.filter(s => s !== undefined);
    
    // Sort streams by estimated size (smallest first for better performance)
    const streamSizes = validStreams.map(stream => {
      const stats = this.statistics.get(stream.source);
      const selectorSelectivity = stream.selector ? 0.5 : 1.0; // Assume 50% selectivity for filters
      return {
        source: stream.source,
        estimatedSize: (stats?.totalEvents || 1000000) * selectorSelectivity
      };
    });
    
    // Sort by estimated size (smallest first)
    streamSizes.sort((a, b) => a.estimatedSize - b.estimatedSize);
    
    return streamSizes.map(s => s.source);
  }

  /**
   * Extract predicates that can be pushed down to the data source
   */
  private extractPushdownPredicates(query: ParsedQuery): string[] {
    const predicates: string[] = [];
    
    // Extract predicates from left stream
    if (query.leftStream.selector) {
      predicates.push(...this.extractPredicatesFromSelector(query.leftStream.selector));
    }
    
    // Extract predicates from right stream
    if (query.rightStream?.selector) {
      predicates.push(...this.extractPredicatesFromSelector(query.rightStream.selector));
    }
    
    // Extract time range predicates
    if (query.leftStream.timeRange) {
      predicates.push(`timestamp >= NOW() - INTERVAL '${query.leftStream.timeRange}'`);
    }
    
    return predicates;
  }

  /**
   * Extract individual predicates from a selector string
   */
  private extractPredicatesFromSelector(selector: string): string[] {
    const predicates: string[] = [];
    
    // Extract conditions from selector
    const match = selector.match(/\{([^}]+)\}/);
    if (match) {
      const conditions = match[1].split(',');
      for (const condition of conditions) {
        const trimmed = condition.trim();
        if (trimmed) {
          predicates.push(trimmed);
        }
      }
    }
    
    return predicates;
  }

  /**
   * Parse time window to milliseconds
   */
  private parseTimeWindow(window: string): number {
    const match = window.match(/^(\d+)([smhd])$/);
    if (!match) return 5 * 60 * 1000; // Default 5 minutes
    
    const [, value, unit] = match;
    const num = parseInt(value, 10);
    
    switch (unit) {
      case 's': return num * 1000;
      case 'm': return num * 60 * 1000;
      case 'h': return num * 60 * 60 * 1000;
      case 'd': return num * 24 * 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }

  /**
   * Update statistics for a data source
   */
  updateStatistics(source: string, stats: SourceStatistics): void {
    this.statistics.set(source, stats);
  }

  /**
   * Get current statistics
   */
  getStatistics(): Map<string, SourceStatistics> {
    return this.statistics;
  }
}

/**
 * Statistics for a data source
 */
export interface SourceStatistics {
  /**
   * Total number of events
   */
  totalEvents: number;
  
  /**
   * Time range covered in hours
   */
  timeRangeHours: number;
  
  /**
   * Number of unique values for common join keys
   */
  cardinality?: {
    request_id?: number;
    trace_id?: number;
    session_id?: number;
    user_id?: number;
  };
  
  /**
   * Average event size in bytes
   */
  avgEventSize?: number;
  
  /**
   * Last updated timestamp
   */
  lastUpdated: Date;
}