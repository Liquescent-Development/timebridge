import { LogEvent } from "./types";
import * as crypto from "crypto";

export interface DeduplicationOptions {
  windowSize: number;
  hashFields?: string[];
  maxCacheSize?: number;
}

export class EventDeduplicator {
  private seenHashes: Map<string, number> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(private options: DeduplicationOptions) {
    // Start cleanup timer
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, options.windowSize);
  }

  /**
   * Check if an event is a duplicate
   * @returns true if duplicate, false if new event
   */
  isDuplicate(event: LogEvent): boolean {
    const hash = this.computeHash(event);
    const now = Date.now();

    // Check if we've seen this hash recently
    const lastSeen = this.seenHashes.get(hash);
    if (lastSeen && now - lastSeen < this.options.windowSize) {
      return true; // Duplicate within window
    }

    // Mark as seen
    this.seenHashes.set(hash, now);

    // Enforce max cache size
    if (
      this.options.maxCacheSize &&
      this.seenHashes.size > this.options.maxCacheSize
    ) {
      this.cleanup();
    }

    return false;
  }

  /**
   * Filter out duplicate events from a stream
   */
  async *deduplicate<T extends LogEvent>(
    stream: AsyncIterable<T>
  ): AsyncGenerator<T> {
    for await (const event of stream) {
      if (!this.isDuplicate(event)) {
        yield event;
      }
    }
  }

  private computeHash(event: LogEvent): string {
    const fields = this.options.hashFields || [
      "timestamp",
      "message",
      "source",
    ];
    const data: Record<string, string | undefined> = {};

    // Extract specified fields for hashing
    for (const field of fields) {
      if (field === "timestamp") data.timestamp = event.timestamp;
      else if (field === "message") data.message = event.message;
      else if (field === "source") data.source = event.source;
      else if (field === "labels" && event.labels) {
        data.labels = JSON.stringify(event.labels);
      }
    }

    // Create hash
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");

    return hash;
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.options.windowSize;

    // Remove old entries
    for (const [hash, timestamp] of this.seenHashes.entries()) {
      if (timestamp < cutoff) {
        this.seenHashes.delete(hash);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.seenHashes.clear();
  }
}
