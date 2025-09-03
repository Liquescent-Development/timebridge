"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamJoiner = void 0;
const time_window_1 = require("./time-window");
class StreamJoiner {
  constructor(options) {
    this.options = options;
    this.windows = [];
    this.correlationCounter = 0;
  }
  async *join(leftStream, rightStream) {
    // Batch processing for compatibility with existing tests
    const leftEvents = new Map();
    const rightEvents = new Map();
    // Process streams in parallel
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
  async *joinRealtime(leftStream, rightStream) {
    // Real-time processing with immediate emission
    yield* this.joinRealtimeImpl(leftStream, rightStream);
  }
  async *joinRealtimeImpl(leftStream, rightStream) {
    const leftEvents = new Map();
    const rightEvents = new Map();
    const emittedJoinKeys = new Set(); // Track which join keys have been emitted
    // Track timing for late tolerance
    const eventArrivalTimes = new Map();
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
  async processStreamRealtime(
    stream,
    ownStorage,
    otherStorage,
    emittedJoinKeys,
    pushCorrelation,
    eventArrivalTimes,
    side
  ) {
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
      ownStorage.get(joinKeyValue).push(event);
      // Record arrival time for this join key
      const timeKey = `${side}:${joinKeyValue}`;
      if (!eventArrivalTimes.has(timeKey)) {
        eventArrivalTimes.set(timeKey, arrivalTime);
      }
      // Check for matches in the other stream
      if (otherStorage.has(joinKeyValue)) {
        // We have matching events - emit correlation immediately
        const otherEvents = otherStorage.get(joinKeyValue);
        const ownEvents = ownStorage.get(joinKeyValue);
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
        const ownEvents = ownStorage.get(joinKeyValue);
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
  isEventTooLate(event, arrivalTime, eventArrivalTimes) {
    // Check if event arrives too late based on lateTolerance
    for (const [key, firstArrival] of eventArrivalTimes) {
      if (arrivalTime - firstArrival > this.options.lateTolerance) {
        // Check if this event would correlate with the early event
        const [_side, joinKey] = key.split(":");
        const eventJoinKey = this.extractJoinKey(event);
        if (eventJoinKey === joinKey) {
          return true; // Event is too late
        }
      }
    }
    return false;
  }
  async emitPendingCorrelations(pendingCorrelations) {
    const emitted = [];
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
  findRemainingCorrelations(leftEvents, rightEvents, emittedJoinKeys) {
    const correlations = [];
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
              [...leftEventList, ...rightEvents.get(key)],
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
                [...leftEventList, ...rightEvents.get(key)],
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
  isDuplicateCorrelation(correlation, emittedCorrelations) {
    const key = this.generateCorrelationKey(correlation);
    return emittedCorrelations.has(key);
  }
  async processStream(stream, storage) {
    for await (const event of stream) {
      // Extract join key value
      const joinKeyValue = this.extractJoinKey(event);
      if (!joinKeyValue) continue;
      // Store event
      if (!storage.has(joinKeyValue)) {
        storage.set(joinKeyValue, []);
      }
      storage.get(joinKeyValue).push(event);
    }
  }
  generateCorrelationKey(correlation) {
    // Create a stable, unique key for deduplication
    const eventIds = correlation.events
      .map((e) => `${e.source}:${e.timestamp}:${e.message}`)
      .sort() // Ensure consistent ordering
      .join("|");
    return `${correlation.joinKey}:${correlation.joinValue}:${correlation.metadata.completeness}:${eventIds}`;
  }
  createNewWindow() {
    const window = new time_window_1.TimeWindow({
      windowSize: this.options.timeWindow,
      lateTolerance: this.options.lateTolerance,
      maxEvents: this.options.maxEvents,
    });
    this.windows.push(window);
    return window;
  }
  filterByTemporal(leftEvents, rightEvents, temporalMs) {
    const allEvents = [];
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
  extractJoinKey(event) {
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
      const keyParts = [];
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
  findCorrelations(leftEvents, rightEvents) {
    const correlations = [];
    const processedKeys = new Set();
    // Process based on join type
    if (this.options.joinType === "and") {
      // Inner join - only keys present in both
      for (const [key, leftEventList] of leftEvents) {
        if (rightEvents.has(key) && !processedKeys.has(key)) {
          const rightEventList = rightEvents.get(key);
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
  applyFilter(events) {
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
  correlationMatchesFilter(events) {
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
  parseMatchers(expr) {
    const matchers = [];
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
  matchValue(actual, operator, expected) {
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
  createCorrelation(joinValue, events, completeness) {
    // Apply filter at event level for backward compatibility with tests
    // The filter could be interpreted two ways:
    // 1. Post-correlation filter: Keep correlations where at least one event matches
    // 2. Event filter: Keep only matching events within correlations
    // We use approach 2 for backward compatibility
    const filteredEvents = this.applyFilter(events);
    if (filteredEvents.length === 0) {
      // If filter removes all events, skip this correlation
      return null;
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
  createCorrelationChannel() {
    const queue = [];
    let resolvers = [];
    let closed = false;
    const push = (item) => {
      if (closed) return;
      if (resolvers.length > 0) {
        const resolver = resolvers.shift();
        resolver({ value: item, done: false });
      } else {
        queue.push(item);
      }
    };
    const close = () => {
      closed = true;
      for (const resolver of resolvers) {
        resolver({ value: undefined, done: true });
      }
      resolvers = [];
    };
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (queue.length > 0) {
              return { value: queue.shift(), done: false };
            }
            if (closed) {
              return { value: undefined, done: true };
            }
            return new Promise((resolve) => {
              resolvers.push(resolve);
            });
          },
        };
      },
    };
    return { push, close, iterable };
  }
  cleanup() {
    for (const window of this.windows) {
      window.clear();
    }
    this.windows = [];
  }
}
exports.StreamJoiner = StreamJoiner;
//# sourceMappingURL=stream-joiner.js.map
