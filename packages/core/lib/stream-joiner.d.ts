import { LogEvent, CorrelatedEvent } from "./types";
import { JoinType } from "@liquescent/log-correlator-query-parser";
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
  labelMappings?: Array<{
    left: string;
    right: string;
  }>;
  filter?: string;
}
export declare class StreamJoiner {
  private options;
  private windows;
  private correlationCounter;
  constructor(options: StreamJoinerOptions);
  join(
    leftStream: AsyncIterable<LogEvent>,
    rightStream: AsyncIterable<LogEvent>
  ): AsyncGenerator<CorrelatedEvent>;
  joinRealtime(
    leftStream: AsyncIterable<LogEvent>,
    rightStream: AsyncIterable<LogEvent>
  ): AsyncGenerator<CorrelatedEvent>;
  private joinRealtimeImpl;
  private processStreamRealtime;
  private isEventTooLate;
  private emitPendingCorrelations;
  private findRemainingCorrelations;
  private isDuplicateCorrelation;
  private processStream;
  private generateCorrelationKey;
  private createNewWindow;
  private filterByTemporal;
  private extractJoinKey;
  private findCorrelations;
  private applyFilter;
  private correlationMatchesFilter;
  private parseMatchers;
  private matchValue;
  private createCorrelation;
  private createCorrelationChannel;
  cleanup(): void;
}
//# sourceMappingURL=stream-joiner.d.ts.map
