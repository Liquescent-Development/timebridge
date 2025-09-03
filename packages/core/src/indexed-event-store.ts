import { LogEvent } from "./types";

/**
 * High-performance indexed storage for join key lookups
 */
export class IndexedEventStore {
  // Primary storage by join key
  private joinKeyIndex: Map<string, Map<string, LogEvent[]>> = new Map();

  // Secondary index by timestamp for time-based queries
  private timeIndex: Array<{ timestamp: number; event: LogEvent }> = [];

  // Statistics
  private stats = {
    totalEvents: 0,
    indexHits: 0,
    indexMisses: 0,
  };

  /**
   * Add an event to the indexed store
   */
  addEvent(event: LogEvent, joinKeys: string[]): void {
    for (const key of joinKeys) {
      const value = this.extractJoinValue(event, key);
      if (value) {
        // Get or create index for this join key
        if (!this.joinKeyIndex.has(key)) {
          this.joinKeyIndex.set(key, new Map());
        }

        const keyIndex = this.joinKeyIndex.get(key)!;

        // Get or create event list for this value
        if (!keyIndex.has(value)) {
          keyIndex.set(value, []);
        }

        keyIndex.get(value)!.push(event);
      }
    }

    // Add to time index
    this.timeIndex.push({
      timestamp: new Date(event.timestamp).getTime(),
      event,
    });

    // Keep time index sorted
    this.timeIndex.sort((a, b) => a.timestamp - b.timestamp);

    this.stats.totalEvents++;
  }

  /**
   * Fast lookup by join key and value
   * O(1) average case complexity
   */
  getEventsByJoinKey(key: string, value: string): LogEvent[] {
    const keyIndex = this.joinKeyIndex.get(key);
    if (!keyIndex) {
      this.stats.indexMisses++;
      return [];
    }

    const events = keyIndex.get(value);
    if (!events) {
      this.stats.indexMisses++;
      return [];
    }

    this.stats.indexHits++;
    return events;
  }

  /**
   * Get events within a time range (using binary search)
   * O(log n) for search + O(k) for retrieval where k is result size
   */
  getEventsByTimeRange(startTime: number, endTime: number): LogEvent[] {
    // Binary search for start position
    let left = 0;
    let right = this.timeIndex.length - 1;
    let startIdx = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (this.timeIndex[mid].timestamp >= startTime) {
        startIdx = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    if (startIdx === -1) return [];

    // Collect events within range
    const results: LogEvent[] = [];
    for (let i = startIdx; i < this.timeIndex.length; i++) {
      if (this.timeIndex[i].timestamp > endTime) break;
      results.push(this.timeIndex[i].event);
    }

    return results;
  }

  /**
   * Find correlations between two sets of join keys
   * Returns matching events grouped by join value
   */
  findCorrelations(
    leftKey: string,
    rightKey: string
  ): Map<string, { left: LogEvent[]; right: LogEvent[] }> {
    const correlations = new Map<
      string,
      { left: LogEvent[]; right: LogEvent[] }
    >();

    const leftIndex = this.joinKeyIndex.get(leftKey);
    const rightIndex = this.joinKeyIndex.get(rightKey);

    if (!leftIndex || !rightIndex) {
      return correlations;
    }

    // Find intersection of values
    for (const [value, leftEvents] of leftIndex) {
      const rightEvents = rightIndex.get(value);
      if (rightEvents) {
        correlations.set(value, {
          left: leftEvents,
          right: rightEvents,
        });
      }
    }

    return correlations;
  }

  private extractJoinValue(event: LogEvent, key: string): string | null {
    // Check labels first
    if (event.labels && event.labels[key]) {
      return event.labels[key];
    }

    // Check join keys
    if (event.joinKeys && event.joinKeys[key]) {
      return event.joinKeys[key];
    }

    return null;
  }

  /**
   * Clean up old events outside the time window
   */
  pruneOldEvents(cutoffTime: number): void {
    // Binary search for cutoff position
    let left = 0;
    let right = this.timeIndex.length - 1;
    let cutoffIdx = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (this.timeIndex[mid].timestamp < cutoffTime) {
        cutoffIdx = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (cutoffIdx >= 0) {
      // Remove old events from time index
      const removedEvents = this.timeIndex.splice(0, cutoffIdx + 1);

      // Remove from join key indexes
      for (const { event } of removedEvents) {
        for (const [, index] of this.joinKeyIndex) {
          for (const [value, events] of index) {
            const idx = events.indexOf(event);
            if (idx >= 0) {
              events.splice(idx, 1);
              if (events.length === 0) {
                index.delete(value);
              }
            }
          }
        }
        this.stats.totalEvents--;
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      hitRate:
        this.stats.indexHits / (this.stats.indexHits + this.stats.indexMisses),
    };
  }

  clear(): void {
    this.joinKeyIndex.clear();
    this.timeIndex = [];
    this.stats.totalEvents = 0;
  }
}
