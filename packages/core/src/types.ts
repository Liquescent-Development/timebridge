export interface LogEvent {
  timestamp: string;
  source: string;
  stream?: string;
  message: string;
  labels: Record<string, string>;
  joinKeys?: Record<string, string>;
}

export interface CorrelatedEvent {
  correlationId: string;
  timestamp: string;
  timeWindow: {
    start: string;
    end: string;
  };
  joinKey: string;
  joinValue: string;
  events: Array<{
    alias?: string;
    source: string;
    timestamp: string;
    message: string;
    labels: Record<string, string>;
  }>;
  metadata: {
    completeness: "complete" | "partial";
    matchedStreams: string[];
    totalStreams: number;
  };
}

/**
 * Unified result type for TimeQL queries
 * Provides clear type discrimination between single events and correlations
 */
export interface TimeQLResult {
  type: 'event' | 'correlation';
  data: LogEvent | CorrelatedEvent;
}

/**
 * Type guard for LogEvent results
 */
export function isEventResult(result: TimeQLResult): result is TimeQLResult & { type: 'event'; data: LogEvent } {
  return result.type === 'event';
}

/**
 * Type guard for CorrelatedEvent results
 */
export function isCorrelationResult(result: TimeQLResult): result is TimeQLResult & { type: 'correlation'; data: CorrelatedEvent } {
  return result.type === 'correlation';
}

export interface CorrelationEngineOptions {
  defaultTimeWindow?: string;
  timeWindow?: number;
  maxEvents?: number;
  lateTolerance?: string | number;
  joinType?: "inner" | "left" | "outer";
  bufferSize?: number;
  processingInterval?: string | number;
  maxMemoryMB?: number;
  gcInterval?: string | number;
}

export interface StreamOptions {
  timeRange?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface StreamQuery {
  source: string;
  stream?: string;  // Optional stream name for filtering
  selector: string;
  timeRange?: string;
}

export type JoinType = 'inner' | 'left' | 'anti' | 'and' | 'or' | 'unless';

export interface GroupingConfig {
  side: "left" | "right";
  labels: string[];
}

export interface ParsedQuery {
  leftStream: StreamQuery;
  rightStream?: StreamQuery;  // Made optional for single-stream queries
  joinType: JoinType;
  joinKeys: string[];
  timeWindow?: string;
  temporal?: string;
  grouping?: GroupingConfig;
  ignoring?: string[];
  labelMappings?: Array<{
    left: string;
    right: string;
  }>;
  filter?: string;
  additionalStreams?: StreamQuery[];
  metadata?: Record<string, any>;  // Added for query hints and other metadata
}

export interface DataSourceAdapter {
  createStream(query: string, options?: StreamOptions): AsyncIterable<LogEvent>;
  validateQuery(query: string): boolean;
  getName(): string;
  getAvailableStreams?(): Promise<string[]>;
  destroy(): Promise<void>;
}

export class CorrelationError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = "CorrelationError";
    this.code = code;
    this.details = details;
  }
}
