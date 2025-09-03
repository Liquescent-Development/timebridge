"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiStreamJoiner = void 0;
const utils_1 = require("./utils");
class MultiStreamJoiner {
  constructor(options) {
    this.options = options;
    this.correlationCounter = 0;
    this.temporalWindow = 0;
    if (options.temporal) {
      this.temporalWindow = (0, utils_1.parseTimeWindow)(options.temporal);
    }
  }
  cleanup() {
    // Clean up resources
    this.correlationCounter = 0;
  }
  async *joinMultiple(streams) {
    const streamData = streams.map((s) => ({
      name: s.name,
      events: new Map(),
      stream: s.stream,
    }));
    // Process all streams concurrently
    const promises = streamData.map((sd) =>
      this.processStream(sd.stream, sd.events, sd.name)
    );
    // Start correlation checking
    const correlationInterval = setInterval(() => {
      // TODO: Process correlations in real-time
      // this.findMultiStreamCorrelations(streamData);
    }, 100);
    try {
      // Wait for all streams to complete
      await Promise.all(promises);
      // Final correlation check
      const correlations = this.findMultiStreamCorrelations(streamData);
      for (const correlation of correlations) {
        if (this.applyFilter(correlation)) {
          yield correlation;
        }
      }
    } finally {
      clearInterval(correlationInterval);
    }
  }
  async processStream(stream, storage, _streamName) {
    for await (const event of stream) {
      const joinKeyValue = this.extractJoinKey(event);
      if (!joinKeyValue) continue;
      if (!storage.has(joinKeyValue)) {
        storage.set(joinKeyValue, []);
      }
      storage.get(joinKeyValue).push(event);
    }
  }
  extractJoinKey(event) {
    // Check for label mappings
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
  findMultiStreamCorrelations(streamData) {
    const correlations = [];
    const processedKeys = new Set();
    // Get all unique join keys across all streams
    const allKeys = new Set();
    for (const sd of streamData) {
      for (const key of sd.events.keys()) {
        allKeys.add(key);
      }
    }
    // Process each unique key
    for (const key of allKeys) {
      if (processedKeys.has(key)) continue;
      const eventsForKey = [];
      const matchedStreams = [];
      // Collect events from all streams for this key
      for (const sd of streamData) {
        const streamEvents = sd.events.get(key) || [];
        if (streamEvents.length > 0) {
          eventsForKey.push(...streamEvents);
          matchedStreams.push(sd.name);
        }
      }
      // Apply join type logic
      const shouldInclude = this.shouldIncludeCorrelation(
        matchedStreams.length,
        streamData.length
      );
      if (shouldInclude && eventsForKey.length > 0) {
        // Apply temporal filtering if specified
        const temporalFiltered = this.applyTemporalFilter(eventsForKey);
        if (temporalFiltered.length > 0) {
          correlations.push(
            this.createCorrelation(
              key,
              temporalFiltered,
              matchedStreams,
              streamData.length
            )
          );
        }
      }
      processedKeys.add(key);
    }
    return correlations;
  }
  shouldIncludeCorrelation(matchedCount, totalStreams) {
    switch (this.options.joinType) {
      case "and":
        // Inner join - all streams must have events
        return matchedCount === totalStreams;
      case "or":
        // Left join - at least one stream must have events
        return matchedCount > 0;
      case "unless":
        // Anti-join - only single stream events
        return matchedCount === 1;
      default:
        return false;
    }
  }
  applyTemporalFilter(events) {
    if (!this.temporalWindow) {
      return events;
    }
    // Sort events by timestamp
    const sorted = [...events].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    if (sorted.length === 0) return [];
    const filtered = [];
    const baseTime = new Date(sorted[0].timestamp).getTime();
    for (const event of sorted) {
      const eventTime = new Date(event.timestamp).getTime();
      if (eventTime - baseTime <= this.temporalWindow) {
        filtered.push(event);
      }
    }
    return filtered;
  }
  applyFilter(correlation) {
    if (!this.options.filter) {
      return true;
    }
    // Parse filter expression (simplified - would use proper parser in production)
    // Example: {status=~"4..|5.."}
    const filterMatch = this.options.filter.match(/\{([^}]+)\}/);
    if (!filterMatch) return true;
    const filterExpr = filterMatch[1];
    const filters = filterExpr.split(",").map((f) => f.trim());
    for (const filter of filters) {
      // Handle regex matching
      const regexMatch = filter.match(/(\w+)=~"([^"]+)"/);
      if (regexMatch) {
        const [, field, pattern] = regexMatch;
        const regex = new RegExp(pattern);
        // Check if any event matches the filter
        const hasMatch = correlation.events.some((event) => {
          const value = event.labels[field];
          return value && regex.test(value);
        });
        if (!hasMatch) return false;
      }
      // Handle exact matching
      const exactMatch = filter.match(/(\w+)="([^"]+)"/);
      if (exactMatch) {
        const [, field, value] = exactMatch;
        const hasMatch = correlation.events.some(
          (event) => event.labels[field] === value
        );
        if (!hasMatch) return false;
      }
    }
    return true;
  }
  createCorrelation(joinValue, events, matchedStreams, totalStreams) {
    // Sort events by timestamp
    events.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const earliestTime = events[0].timestamp;
    const latestTime = events[events.length - 1].timestamp;
    return {
      correlationId: `corr_${++this.correlationCounter}`,
      timestamp: earliestTime,
      timeWindow: {
        start: earliestTime,
        end: latestTime,
      },
      joinKey: this.options.joinKeys[0],
      joinValue,
      events: events.map((e) => ({
        alias: e.stream,
        source: e.source,
        timestamp: e.timestamp,
        message: e.message,
        labels: e.labels,
      })),
      metadata: {
        completeness:
          matchedStreams.length === totalStreams ? "complete" : "partial",
        matchedStreams,
        totalStreams,
      },
    };
  }
}
exports.MultiStreamJoiner = MultiStreamJoiner;
//# sourceMappingURL=multi-stream-joiner.js.map
