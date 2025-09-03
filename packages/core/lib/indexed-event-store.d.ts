import { LogEvent } from "./types";
/**
 * High-performance indexed storage for join key lookups
 */
export declare class IndexedEventStore {
  private joinKeyIndex;
  private timeIndex;
  private stats;
  /**
   * Add an event to the indexed store
   */
  addEvent(event: LogEvent, joinKeys: string[]): void;
  /**
   * Fast lookup by join key and value
   * O(1) average case complexity
   */
  getEventsByJoinKey(key: string, value: string): LogEvent[];
  /**
   * Get events within a time range (using binary search)
   * O(log n) for search + O(k) for retrieval where k is result size
   */
  getEventsByTimeRange(startTime: number, endTime: number): LogEvent[];
  /**
   * Find correlations between two sets of join keys
   * Returns matching events grouped by join value
   */
  findCorrelations(
    leftKey: string,
    rightKey: string
  ): Map<
    string,
    {
      left: LogEvent[];
      right: LogEvent[];
    }
  >;
  private extractJoinValue;
  /**
   * Clean up old events outside the time window
   */
  pruneOldEvents(cutoffTime: number): void;
  getStats(): {
    hitRate: number;
    totalEvents: number;
    indexHits: number;
    indexMisses: number;
  };
  clear(): void;
}
//# sourceMappingURL=indexed-event-store.d.ts.map
