import { LogEvent, CorrelatedEvent } from "./types";
import { JoinType } from "@timebridge/timeql-parser";
import { TimeWindow } from "./time-window";

export interface StreamJoinerOptions {
  joinType: JoinType;
  joinKeys: string[];
  timeWindow: number;
  lateTolerance: number;
  maxEvents: number;
  temporal?: number;
  ignoring?: string[];
  grouping?: {
    side: "left" | "right";
    labels: string[];
  };
  labelMappings?: Array<{ left: string; right: string }>;
  filter?: string;
}

export class StreamJoiner {
  private windows: TimeWindow[] = [];
  private correlationCounter = 0;

  constructor(private options: StreamJoinerOptions) {}

  async *join(
    leftStream: AsyncIterable<LogEvent>,
    rightStream: AsyncIterable<LogEvent>
  ): AsyncGenerator<CorrelatedEvent> {
    // For large datasets, use streaming correlation with smart eviction
    const leftEvents: Map<string, LogEvent[]> = new Map();
    const rightEvents: Map<string, LogEvent[]> = new Map();
    
    // Check if we should use streaming mode (for large time windows)
    const useStreamingMode = this.options.timeWindow > 3600000; // > 1 hour
    
    if (useStreamingMode) {
      console.log(`[StreamJoiner] Using streaming correlation mode for large time window (${this.options.timeWindow}ms)`);
      // Use streaming correlation with memory management
      yield* this.joinStreaming(leftStream, rightStream);
    } else {
      // Batch processing for compatibility with existing tests and smaller datasets
      await Promise.all([
        this.processStream(leftStream, leftEvents),
        this.processStream(rightStream, rightEvents),
      ]);

      // Find and emit correlations
      const correlations = this.findCorrelations(leftEvents, rightEvents);
      for (const correlation of correlations) {
        yield correlation;
      }
    }
  }

  private async *joinStreaming(
    leftStream: AsyncIterable<LogEvent>,
    rightStream: AsyncIterable<LogEvent>
  ): AsyncGenerator<CorrelatedEvent> {
    // Streaming correlation for large datasets with memory management
    const leftStorage = new Map<string, LogEvent[]>();
    const rightStorage = new Map<string, LogEvent[]>();
    const emittedKeys = new Set<string>();
    
    // Track time boundaries for eviction
    let globalMinTime: number | null = null;
    let globalMaxTime: number | null = null;
    
    // Process streams with interleaved correlation and eviction
    const correlationChannel = this.createCorrelationChannel();
    
    const leftProcessor = this.processStreamWithCorrelation(
      leftStream,
      leftStorage,
      rightStorage,
      emittedKeys,
      correlationChannel.push,
      "left"
    );
    
    const rightProcessor = this.processStreamWithCorrelation(
      rightStream,
      rightStorage,
      leftStorage,
      emittedKeys,
      correlationChannel.push,
      "right"
    );
    
    // Process both streams concurrently
    const processingComplete = Promise.all([leftProcessor, rightProcessor]).then(() => {
      // Emit any remaining correlations
      const remaining = this.findCorrelations(leftStorage, rightStorage);
      for (const corr of remaining) {
        if (!emittedKeys.has(corr.joinValue)) {
          correlationChannel.push(corr);
        }
      }
      correlationChannel.close();
    });
    
    // Yield correlations as they are found
    for await (const correlation of correlationChannel.iterable) {
      yield correlation;
    }
    
    await processingComplete;
  }

  async *joinRealtime(
    leftStream: AsyncIterable<LogEvent>,
    rightStream: AsyncIterable<LogEvent>
  ): AsyncGenerator<CorrelatedEvent> {
    // Real-time processing with immediate emission
    yield* this.joinRealtimeImpl(leftStream, rightStream);
  }

  private async *joinRealtimeImpl(
    leftStream: AsyncIterable<LogEvent>,
    rightStream: AsyncIterable<LogEvent>
  ): AsyncGenerator<CorrelatedEvent> {
    const leftEvents: Map<string, LogEvent[]> = new Map();
    const rightEvents: Map<string, LogEvent[]> = new Map();
    const emittedJoinKeys = new Set<string>(); // Track which join keys have been emitted

    // Track timing for late tolerance
    const eventArrivalTimes = new Map<string, number>();

    // Create a channel for correlations
    const correlationChannel = this.createCorrelationChannel();

    // Process streams concurrently with real-time correlation emission
    const leftPromise = this.processStreamRealtime(
      leftStream,
      leftEvents,
      rightEvents,
      emittedJoinKeys,
      correlationChannel.push,
      eventArrivalTimes,
      "left"
    );

    const rightPromise = this.processStreamRealtime(
      rightStream,
      rightEvents,
      leftEvents,
      emittedJoinKeys,
      correlationChannel.push,
      eventArrivalTimes,
      "right"
    );

    // Create a promise that resolves when both streams are done
    const streamsComplete = Promise.all([leftPromise, rightPromise]).then(
      () => {
        correlationChannel.close();
      }
    );

    try {
      // Yield correlations as they become available
      for await (const correlation of correlationChannel.iterable) {
        yield correlation;
      }

      // Wait for streams to complete
      await streamsComplete;

      // Emit any remaining correlations that haven't been emitted yet
      const finalCorrelations = this.findRemainingCorrelations(
        leftEvents,
        rightEvents,
        emittedJoinKeys
      );
      for (const correlation of finalCorrelations) {
        yield correlation;
      }
    } finally {
      // Cleanup
    }
  }

  private async processStreamWithCorrelation(
    stream: AsyncIterable<LogEvent>,
    ownStorage: Map<string, LogEvent[]>,
    otherStorage: Map<string, LogEvent[]>,
    emittedKeys: Set<string>,
    pushCorrelation: (correlation: CorrelatedEvent) => void,
    side: "left" | "right"
  ): Promise<void> {
    let eventCount = 0;
    let minTime: number | null = null;
    let maxTime: number | null = null;
    let evictedCount = 0;
    const keyTimes = new Map<string, { min: number; max: number }>();
    
    // Limit how many events we store per key to prevent memory exhaustion
    const MAX_EVENTS_PER_KEY = 100;
    
    for await (const event of stream) {
      eventCount++;
      const eventTimeMs = new Date(event.timestamp).getTime();
      
      // Update time boundaries
      if (minTime === null || eventTimeMs < minTime) minTime = eventTimeMs;
      if (maxTime === null || eventTimeMs > maxTime) maxTime = eventTimeMs;
      
      // Extract join key
      const joinKey = this.extractJoinKey(event);
      if (!joinKey) continue;
      
      // Store event with limit
      if (!ownStorage.has(joinKey)) {
        ownStorage.set(joinKey, []);
        keyTimes.set(joinKey, { min: eventTimeMs, max: eventTimeMs });
      } else {
        const times = keyTimes.get(joinKey)!;
        if (eventTimeMs < times.min) times.min = eventTimeMs;
        if (eventTimeMs > times.max) times.max = eventTimeMs;
      }
      
      const eventList = ownStorage.get(joinKey)!;
      if (eventList.length < MAX_EVENTS_PER_KEY) {
        eventList.push(event);
      } else {
        // Replace oldest event if we hit the limit
        eventList.shift();
        eventList.push(event);
      }
      
      // Check for immediate correlation
      if (otherStorage.has(joinKey) && !emittedKeys.has(joinKey)) {
        const otherEvents = otherStorage.get(joinKey)!;
        const ownEvents = ownStorage.get(joinKey)!;
        
        // Check temporal constraint if needed
        if (this.options.temporal) {
          const withinTemporal = this.checkTemporalConstraint(ownEvents, otherEvents, this.options.temporal);
          if (!withinTemporal) continue;
        }
        
        const events = side === "left" 
          ? [...ownEvents, ...otherEvents]
          : [...otherEvents, ...ownEvents];
          
        const correlation = this.createCorrelation(joinKey, events, "complete");
        if (correlation) {
          pushCorrelation(correlation);
          emittedKeys.add(joinKey);
          
          // After emitting, we can free up memory for this key
          ownStorage.delete(joinKey);
          keyTimes.delete(joinKey);
        }
      }
      
      // More aggressive memory management
      if (eventCount % 5000 === 0) {
        // Remove keys that have been emitted
        for (const key of emittedKeys) {
          if (ownStorage.has(key)) {
            evictedCount += ownStorage.get(key)?.length || 0;
            ownStorage.delete(key);
            keyTimes.delete(key);
          }
        }
        
        // Also limit total storage size
        if (ownStorage.size > 10000) {
          console.log(`[StreamJoiner.${side}] Storage limit reached (${ownStorage.size} keys), removing oldest keys`);
          const keysToRemove = Array.from(keyTimes.entries())
            .sort(([, a], [, b]) => a.min - b.min)
            .slice(0, ownStorage.size - 5000)
            .map(([key]) => key);
            
          for (const key of keysToRemove) {
            if (!emittedKeys.has(key)) {
              evictedCount += ownStorage.get(key)?.length || 0;
              ownStorage.delete(key);
              keyTimes.delete(key);
            }
          }
        }
        
        if (eventCount % 10000 === 0) {
          const memUsage = process.memoryUsage();
          console.log(`[StreamJoiner.${side}] Progress: ${eventCount} events, ${ownStorage.size} keys in memory, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap used`);
        }
      }
    }
    
    console.log(`[StreamJoiner.${side}] Processed ${eventCount} events, ${ownStorage.size} unique keys, evicted ${evictedCount} events`);
  }
  
  private checkTemporalConstraint(
    events1: LogEvent[],
    events2: LogEvent[],
    temporalMs: number
  ): boolean {
    for (const e1 of events1) {
      const t1 = new Date(e1.timestamp).getTime();
      for (const e2 of events2) {
        const t2 = new Date(e2.timestamp).getTime();
        if (Math.abs(t1 - t2) <= temporalMs) {
          return true;
        }
      }
    }
    return false;
  }

  private async processStreamRealtime(
    stream: AsyncIterable<LogEvent>,
    ownStorage: Map<string, LogEvent[]>,
    otherStorage: Map<string, LogEvent[]>,
    emittedJoinKeys: Set<string>,
    pushCorrelation: (correlation: CorrelatedEvent) => void,
    eventArrivalTimes: Map<string, number>,
    side: "left" | "right"
  ): Promise<void> {
    for await (const event of stream) {
      const arrivalTime = Date.now();

      // Extract join key value
      const joinKeyValue = this.extractJoinKey(event);
      if (!joinKeyValue) continue;

      // Check late tolerance
      if (this.isEventTooLate(event, arrivalTime, eventArrivalTimes)) {
        continue; // Reject late events
      }

      // Store event
      if (!ownStorage.has(joinKeyValue)) {
        ownStorage.set(joinKeyValue, []);
      }
      ownStorage.get(joinKeyValue)!.push(event);

      // Record arrival time for this join key
      const timeKey = `${side}:${joinKeyValue}`;
      if (!eventArrivalTimes.has(timeKey)) {
        eventArrivalTimes.set(timeKey, arrivalTime);
      }

      // Check for matches in the other stream
      if (otherStorage.has(joinKeyValue)) {
        // We have matching events - emit correlation immediately
        const otherEvents = otherStorage.get(joinKeyValue)!;
        const ownEvents = ownStorage.get(joinKeyValue)!;

        // Create correlation with all current events
        const events =
          side === "left"
            ? [...ownEvents, ...otherEvents]
            : [...otherEvents, ...ownEvents];

        const correlation = this.createCorrelation(
          joinKeyValue,
          events,
          "complete"
        );

        if (correlation) {
          // Only emit on first match for this join key
          if (!emittedJoinKeys.has(joinKeyValue)) {
            pushCorrelation(correlation);
            emittedJoinKeys.add(joinKeyValue);
          }
        }
      } else if (
        this.options.joinType === "or" &&
        !otherStorage.has(joinKeyValue)
      ) {
        // For left join, emit partial correlation only if no match exists
        const ownEvents = ownStorage.get(joinKeyValue)!;
        if (ownEvents.length === 1 && !emittedJoinKeys.has(joinKeyValue)) {
          const correlation = this.createCorrelation(
            joinKeyValue,
            ownEvents,
            "partial"
          );

          if (correlation) {
            pushCorrelation(correlation);
            emittedJoinKeys.add(joinKeyValue);
          }
        }
      }
    }
  }

  private isEventTooLate(
    event: LogEvent,
    arrivalTime: number,
    eventArrivalTimes: Map<string, number>
  ): boolean {
    // Check if event arrives too late based on lateTolerance
    for (const [key, firstArrival] of eventArrivalTimes) {
      if (arrivalTime - firstArrival > this.options.lateTolerance) {
        // Check if this event would correlate with the early event
        const [, joinKey] = key.split(":");
        const eventJoinKey = this.extractJoinKey(event);
        if (eventJoinKey === joinKey) {
          return true; // Event is too late
        }
      }
    }
    return false;
  }

  private async emitPendingCorrelations(
    pendingCorrelations: CorrelatedEvent[]
  ): Promise<CorrelatedEvent[]> {
    const emitted: CorrelatedEvent[] = [];
    let index = 0;

    // Poll for new correlations
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (index < pendingCorrelations.length) {
        const correlation = pendingCorrelations[index];
        if (correlation === null) {
          // Sentinel value indicates completion
          break;
        }
        emitted.push(correlation);
        index++;
      } else {
        // Wait a bit for new correlations
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    return emitted;
  }

  private findRemainingCorrelations(
    leftEvents: Map<string, LogEvent[]>,
    rightEvents: Map<string, LogEvent[]>,
    emittedJoinKeys: Set<string>
  ): CorrelatedEvent[] {
    const correlations: CorrelatedEvent[] = [];

    // Emit any correlations that haven't been emitted yet
    // This handles both inner joins and left joins
    for (const [key, leftEventList] of leftEvents) {
      if (!emittedJoinKeys.has(key)) {
        // Check if we should emit this correlation based on join type
        if (this.options.joinType === "and") {
          // Inner join: only emit if there's a match
          if (rightEvents.has(key)) {
            const correlation = this.createCorrelation(
              key,
              [...leftEventList, ...rightEvents.get(key)!],
              "complete"
            );
            if (correlation) {
              correlations.push(correlation);
            }
          }
        } else if (this.options.joinType === "or") {
          // Left join: emit with or without match
          const finalCorrelation = rightEvents.has(key)
            ? this.createCorrelation(
                key,
                [...leftEventList, ...rightEvents.get(key)!],
                "complete"
              )
            : this.createCorrelation(key, leftEventList, "partial");

          if (finalCorrelation) {
            correlations.push(finalCorrelation);
          }
        }
      }
    }

    // For 'unless' (anti-join), emit left events WITHOUT matches
    if (this.options.joinType === "unless") {
      for (const [key, leftEventList] of leftEvents) {
        if (!rightEvents.has(key) && !emittedJoinKeys.has(key)) {
          const correlation = this.createCorrelation(
            key,
            leftEventList,
            "partial"
          );
          if (correlation) {
            correlations.push(correlation);
          }
        }
      }
    }

    return correlations;
  }

  private isDuplicateCorrelation(
    correlation: CorrelatedEvent,
    emittedCorrelations: Set<string>
  ): boolean {
    const key = this.generateCorrelationKey(correlation);
    return emittedCorrelations.has(key);
  }

  private async processStream(
    stream: AsyncIterable<LogEvent>,
    storage: Map<string, LogEvent[]>
  ): Promise<void> {
    let eventCount = 0;
    let keysFound = 0;
    let minTime: Date | null = null;
    let maxTime: Date | null = null;
    let evictedCount = 0;
    
    // Track earliest time for each join key to enable smart eviction
    const keyEarliestTime = new Map<string, number>();
    
    for await (const event of stream) {
      eventCount++;
      
      // Track time range
      const eventTime = new Date(event.timestamp);
      const eventTimeMs = eventTime.getTime();
      if (!minTime || eventTime < minTime) minTime = eventTime;
      if (!maxTime || eventTime > maxTime) maxTime = eventTime;
      
      // Extract join key value
      const joinKeyValue = this.extractJoinKey(event);
      if (!joinKeyValue) {
        if (eventCount <= 5) {
          console.log(`[StreamJoiner] Event ${eventCount} has no join key for keys:`, this.options.joinKeys);
          console.log(`  Labels:`, Object.keys(event.labels || {}).slice(0, 10));
          console.log(`  JoinKeys:`, Object.keys(event.joinKeys || {}).slice(0, 10));
          if (event.labels?.request_id !== undefined) {
            console.log(`  request_id in labels:`, event.labels.request_id);
          }
          if (event.joinKeys?.request_id !== undefined) {
            console.log(`  request_id in joinKeys:`, event.joinKeys.request_id);
          }
        }
        continue;
      }

      keysFound++;
      
      // Store event
      if (!storage.has(joinKeyValue)) {
        storage.set(joinKeyValue, []);
        keyEarliestTime.set(joinKeyValue, eventTimeMs);
      } else {
        // Update earliest time if this event is older
        const currentEarliest = keyEarliestTime.get(joinKeyValue)!;
        if (eventTimeMs < currentEarliest) {
          keyEarliestTime.set(joinKeyValue, eventTimeMs);
        }
      }
      storage.get(joinKeyValue)!.push(event);
      
      // Smart eviction: Every 1000 events, check if we can evict old data  
      // Made more aggressive to prevent memory exhaustion
      if (eventCount % 1000 === 0 && maxTime) {
        const maxTimeMs = maxTime.getTime();
        const evictionThreshold = maxTimeMs - this.options.timeWindow;
        
        // Find keys that are too old to possibly join with future events
        const keysToEvict: string[] = [];
        for (const [key, earliestTime] of keyEarliestTime) {
          if (earliestTime < evictionThreshold) {
            // All events for this key are outside the correlation window
            const events = storage.get(key);
            if (events) {
              // Check if ALL events for this key are too old
              const allTooOld = events.every(e => 
                new Date(e.timestamp).getTime() < evictionThreshold
              );
              
              if (allTooOld) {
                keysToEvict.push(key);
              }
            }
          }
        }
        
        // Evict old keys
        for (const key of keysToEvict) {
          const evictedEvents = storage.get(key)?.length || 0;
          storage.delete(key);
          keyEarliestTime.delete(key);
          evictedCount += evictedEvents;
        }
        
        if (keysToEvict.length > 0) {
          console.log(`[StreamJoiner] Evicted ${keysToEvict.length} keys (${evictedCount} total events evicted) to save memory`);
          console.log(`[StreamJoiner] Current storage: ${storage.size} keys, window: ${this.options.timeWindow}ms`);
        }
      }
    }
    
    console.log(`[StreamJoiner] Processed ${eventCount} events, found ${keysFound} with join keys, unique keys: ${storage.size}`);
    if (evictedCount > 0) {
      console.log(`[StreamJoiner] Evicted ${evictedCount} events total that were outside correlation window`);
    }
    if (minTime && maxTime) {
      console.log(`[StreamJoiner] Time range: ${minTime.toISOString()} to ${maxTime.toISOString()}`);
    }
  }

  private generateCorrelationKey(correlation: CorrelatedEvent): string {
    // Create a stable, unique key for deduplication
    const eventIds = correlation.events
      .map((e) => `${e.source}:${e.timestamp}:${e.message}`)
      .sort() // Ensure consistent ordering
      .join("|");

    return `${correlation.joinKey}:${correlation.joinValue}:${correlation.metadata.completeness}:${eventIds}`;
  }

  private createNewWindow(): TimeWindow {
    const window = new TimeWindow({
      windowSize: this.options.timeWindow,
      lateTolerance: this.options.lateTolerance,
      maxEvents: this.options.maxEvents,
    });
    this.windows.push(window);
    return window;
  }

  private filterByTemporal(
    leftEvents: LogEvent[],
    rightEvents: LogEvent[],
    temporalMs: number
  ): LogEvent[] {
    const allEvents: LogEvent[] = [];

    // For each left event, check if there's a right event within temporal window
    for (const leftEvent of leftEvents) {
      const leftTime = new Date(leftEvent.timestamp).getTime();

      for (const rightEvent of rightEvents) {
        const rightTime = new Date(rightEvent.timestamp).getTime();
        const timeDiff = Math.abs(rightTime - leftTime);

        if (timeDiff <= temporalMs) {
          // Events are within temporal window, include both
          if (!allEvents.includes(leftEvent)) {
            allEvents.push(leftEvent);
          }
          if (!allEvents.includes(rightEvent)) {
            allEvents.push(rightEvent);
          }
        }
      }
    }

    return allEvents;
  }

  private extractJoinKey(event: LogEvent): string | null {
    // Check for label mappings first
    if (this.options.labelMappings) {
      for (const mapping of this.options.labelMappings) {
        const leftValue =
          event.labels[mapping.left] || event.joinKeys?.[mapping.left];
        const rightValue =
          event.labels[mapping.right] || event.joinKeys?.[mapping.right];
        if (leftValue) return leftValue;
        if (rightValue) return rightValue;
      }
    }

    // If ignoring is specified WITHOUT join keys, create composite key from non-ignored labels
    if (
      this.options.ignoring &&
      this.options.ignoring.length > 0 &&
      this.options.joinKeys.length === 0
    ) {
      const keyParts: string[] = [];
      const allLabels = { ...event.labels, ...event.joinKeys };

      for (const [label, value] of Object.entries(allLabels)) {
        if (!this.options.ignoring.includes(label) && value) {
          keyParts.push(`${label}:${value}`);
        }
      }

      return keyParts.length > 0 ? keyParts.sort().join(",") : null;
    }

    // Standard join key extraction
    for (const key of this.options.joinKeys) {
      if (event.labels[key]) {
        return event.labels[key];
      }
      if (event.joinKeys && event.joinKeys[key]) {
        return event.joinKeys[key];
      }
    }

    return null;
  }

  private findCorrelations(
    leftEvents: Map<string, LogEvent[]>,
    rightEvents: Map<string, LogEvent[]>
  ): CorrelatedEvent[] {
    const correlations: CorrelatedEvent[] = [];
    const processedKeys = new Set<string>();
    
    console.log(`[StreamJoiner.findCorrelations] Left events: ${leftEvents.size} keys, Right events: ${rightEvents.size} keys`);

    // Process based on join type
    if (this.options.joinType === "and") {
      // Inner join - only keys present in both
      let matchCount = 0;
      for (const [key, leftEventList] of leftEvents) {
        if (rightEvents.has(key) && !processedKeys.has(key)) {
          matchCount++;
          if (matchCount <= 3) {
            console.log(`[StreamJoiner.findCorrelations] Found match for key: ${key}`);
          }
          const rightEventList = rightEvents.get(key)!;

          // Handle grouping modifiers for many-to-one or one-to-many joins
          if (this.options.grouping) {
            if (this.options.grouping.side === "left") {
              // group_left: Keep all left events, allow multiple right matches
              // Create one correlation per left event with all matching right events
              for (const leftEvent of leftEventList) {
                const correlation = this.createCorrelation(
                  key,
                  [leftEvent, ...rightEventList],
                  "complete"
                );
                if (correlation) {
                  correlations.push(correlation);
                }
              }
            } else {
              // group_right: Keep all right events, allow multiple left matches
              // Create one correlation per right event with all matching left events
              for (const rightEvent of rightEventList) {
                const correlation = this.createCorrelation(
                  key,
                  [...leftEventList, rightEvent],
                  "complete"
                );
                if (correlation) {
                  correlations.push(correlation);
                }
              }
            }
          } else {
            // Standard join without grouping
            // Apply temporal constraint if specified
            if (this.options.temporal !== undefined) {
              // Check if events are within temporal window
              const filteredEvents = this.filterByTemporal(
                leftEventList,
                rightEventList,
                this.options.temporal
              );

              if (filteredEvents.length === 0) {
                continue; // Skip this correlation if no events match temporal constraint
              }

              const correlation = this.createCorrelation(
                key,
                filteredEvents,
                "complete"
              );
              if (correlation) {
                correlations.push(correlation);
              }
            } else {
              const correlation = this.createCorrelation(
                key,
                [...leftEventList, ...rightEventList],
                "complete"
              );
              if (correlation) {
                correlations.push(correlation);
              }
            }
          }
          processedKeys.add(key);
        }
      }
      console.log(`[StreamJoiner.findCorrelations] Inner join found ${matchCount} matching keys`);
    } else if (this.options.joinType === "or") {
      // Left join - all from left, matched from right if available
      for (const [key, leftEventList] of leftEvents) {
        if (!processedKeys.has(key)) {
          const rightEventList = rightEvents.get(key) || [];
          const correlation = this.createCorrelation(
            key,
            [...leftEventList, ...rightEventList],
            rightEventList.length > 0 ? "complete" : "partial"
          );
          if (correlation) {
            correlations.push(correlation);
          }
          processedKeys.add(key);
        }
      }
    } else if (this.options.joinType === "unless") {
      // Anti-join - only keys NOT in right
      for (const [key, leftEventList] of leftEvents) {
        if (!rightEvents.has(key) && !processedKeys.has(key)) {
          const correlation = this.createCorrelation(
            key,
            leftEventList,
            "partial"
          );
          if (correlation) {
            correlations.push(correlation);
          }
          processedKeys.add(key);
        }
      }
    }

    return correlations;
  }

  private applyFilter(events: LogEvent[]): LogEvent[] {
    if (!this.options.filter) {
      return events;
    }

    // Parse filter expression like {status=~"4..|5.."}
    const filterMatch = this.options.filter.match(/\{([^}]+)\}/);
    if (!filterMatch) {
      return events;
    }

    const filterExpr = filterMatch[1];
    const matchers = this.parseMatchers(filterExpr);

    return events.filter((event) => {
      for (const matcher of matchers) {
        const value = event.labels[matcher.label];
        if (!this.matchValue(value, matcher.operator, matcher.value)) {
          return false;
        }
      }
      return true;
    });
  }

  private correlationMatchesFilter(events: LogEvent[]): boolean {
    if (!this.options.filter) {
      return true;
    }

    // Parse filter expression like {status=~"4..|5.."}
    const filterMatch = this.options.filter.match(/\{([^}]+)\}/);
    if (!filterMatch) {
      return true;
    }

    const filterExpr = filterMatch[1];
    const matchers = this.parseMatchers(filterExpr);

    // Check if at least one event matches all matchers
    return events.some((event) => {
      for (const matcher of matchers) {
        const value = event.labels[matcher.label];
        if (!this.matchValue(value, matcher.operator, matcher.value)) {
          return false;
        }
      }
      return true;
    });
  }

  private parseMatchers(
    expr: string
  ): Array<{ label: string; operator: string; value: string }> {
    const matchers: Array<{ label: string; operator: string; value: string }> =
      [];
    // Split by comma, but not within quotes
    const parts = expr.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

    for (const part of parts) {
      const match = part
        .trim()
        .match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]+)"$/);
      if (match) {
        matchers.push({
          label: match[1],
          operator: match[2],
          value: match[3],
        });
      }
    }

    return matchers;
  }

  private matchValue(
    actual: string | undefined,
    operator: string,
    expected: string
  ): boolean {
    if (!actual) {
      return operator === "!=" || operator === "!~";
    }

    switch (operator) {
      case "=":
        return actual === expected;
      case "!=":
        return actual !== expected;
      case "=~":
        try {
          const regex = new RegExp(expected);
          return regex.test(actual);
        } catch {
          return false;
        }
      case "!~":
        try {
          const regex = new RegExp(expected);
          return !regex.test(actual);
        } catch {
          return true;
        }
      default:
        return false;
    }
  }

  private createCorrelation(
    joinValue: string,
    events: LogEvent[],
    completeness: "complete" | "partial"
  ): CorrelatedEvent {
    // Apply filter at event level for backward compatibility with tests
    // The filter could be interpreted two ways:
    // 1. Post-correlation filter: Keep correlations where at least one event matches
    // 2. Event filter: Keep only matching events within correlations
    // We use approach 2 for backward compatibility
    const filteredEvents = this.applyFilter(events);

    if (filteredEvents.length === 0) {
      // If filter removes all events, skip this correlation
      return null as any;
    }

    // Sort events by timestamp
    filteredEvents.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const streams = new Set(filteredEvents.map((e) => e.source));
    const earliestTime = filteredEvents[0].timestamp;
    const latestTime = filteredEvents[filteredEvents.length - 1].timestamp;

    return {
      correlationId: `corr_${++this.correlationCounter}`,
      timestamp: earliestTime,
      timeWindow: {
        start: earliestTime,
        end: latestTime,
      },
      joinKey: this.options.joinKeys[0],
      joinValue,
      events: filteredEvents.map((e) => ({
        alias: e.stream,
        source: e.source,
        timestamp: e.timestamp,
        message: e.message,
        labels: e.labels,
      })),
      metadata: {
        completeness,
        matchedStreams: Array.from(streams),
        totalStreams: 2, // For now, we support 2 streams
      },
    };
  }

  private createCorrelationChannel(): {
    push: (item: CorrelatedEvent) => void;
    close: () => void;
    iterable: AsyncIterable<CorrelatedEvent>;
  } {
    const queue: CorrelatedEvent[] = [];
    let resolvers: Array<(value: IteratorResult<CorrelatedEvent>) => void> = [];
    let closed = false;

    const push = (item: CorrelatedEvent) => {
      if (closed) return;

      if (resolvers.length > 0) {
        const resolver = resolvers.shift()!;
        resolver({ value: item, done: false });
      } else {
        queue.push(item);
      }
    };

    const close = () => {
      closed = true;
      for (const resolver of resolvers) {
        resolver({ value: undefined as any, done: true });
      }
      resolvers = [];
    };

    const iterable: AsyncIterable<CorrelatedEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<CorrelatedEvent>> {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }

            if (closed) {
              return { value: undefined as any, done: true };
            }

            return new Promise<IteratorResult<CorrelatedEvent>>((resolve) => {
              resolvers.push(resolve);
            });
          },
        };
      },
    };

    return { push, close, iterable };
  }

  cleanup(): void {
    for (const window of this.windows) {
      window.clear();
    }
    this.windows = [];
  }
}
