import { LogEvent, CorrelatedEvent } from "./types";
import { JoinType } from "@timebridge/timeql-parser";
import { parseTimeWindow } from "./utils";

export interface MultiStreamJoinerOptions {
  joinType: JoinType;
  joinKeys: string[];
  timeWindow: number;
  lateTolerance: number;
  maxEvents: number;
  temporal?: string;
  labelMappings?: Array<{ left: string; right: string }>;
  filter?: string;
}

interface StreamData {
  name: string;
  events: Map<string, LogEvent[]>;
  stream: AsyncIterable<LogEvent>;
}

export class MultiStreamJoiner {
  private correlationCounter = 0;
  private temporalWindow: number = 0;

  constructor(private options: MultiStreamJoinerOptions) {
    if (options.temporal) {
      this.temporalWindow = parseTimeWindow(options.temporal);
    }
  }

  cleanup(): void {
    // Clean up resources
    this.correlationCounter = 0;
  }

  async *joinMultiple(
    streams: Array<{ name: string; stream: AsyncIterable<LogEvent> }>
  ): AsyncGenerator<CorrelatedEvent> {
    const streamData: StreamData[] = streams.map((s) => ({
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

  private async processStream(
    stream: AsyncIterable<LogEvent>,
    storage: Map<string, LogEvent[]>,
    _streamName: string
  ): Promise<void> {
    for await (const event of stream) {
      const joinKeyValue = this.extractJoinKey(event);
      if (!joinKeyValue) continue;

      if (!storage.has(joinKeyValue)) {
        storage.set(joinKeyValue, []);
      }
      storage.get(joinKeyValue)!.push(event);
    }
  }

  private extractJoinKey(event: LogEvent): string | null {
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

  private findMultiStreamCorrelations(
    streamData: StreamData[]
  ): CorrelatedEvent[] {
    const correlations: CorrelatedEvent[] = [];
    const processedKeys = new Set<string>();

    // Get all unique join keys across all streams
    const allKeys = new Set<string>();
    for (const sd of streamData) {
      for (const key of sd.events.keys()) {
        allKeys.add(key);
      }
    }

    // Process each unique key
    for (const key of allKeys) {
      if (processedKeys.has(key)) continue;

      const eventsForKey: LogEvent[] = [];
      const matchedStreams: string[] = [];

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

  private shouldIncludeCorrelation(
    matchedCount: number,
    totalStreams: number
  ): boolean {
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

  private applyTemporalFilter(events: LogEvent[]): LogEvent[] {
    if (!this.temporalWindow) {
      return events;
    }

    // Sort events by timestamp
    const sorted = [...events].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (sorted.length === 0) return [];

    const filtered: LogEvent[] = [];
    const baseTime = new Date(sorted[0].timestamp).getTime();

    for (const event of sorted) {
      const eventTime = new Date(event.timestamp).getTime();
      if (eventTime - baseTime <= this.temporalWindow) {
        filtered.push(event);
      }
    }

    return filtered;
  }

  private applyFilter(correlation: CorrelatedEvent): boolean {
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

  private createCorrelation(
    joinValue: string,
    events: LogEvent[],
    matchedStreams: string[],
    totalStreams: number
  ): CorrelatedEvent {
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
