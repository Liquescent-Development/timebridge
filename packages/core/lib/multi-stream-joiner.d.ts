import { LogEvent, CorrelatedEvent } from "./types";
import { JoinType } from "@liquescent/log-correlator-query-parser";
export interface MultiStreamJoinerOptions {
  joinType: JoinType;
  joinKeys: string[];
  timeWindow: number;
  lateTolerance: number;
  maxEvents: number;
  temporal?: string;
  labelMappings?: Array<{
    left: string;
    right: string;
  }>;
  filter?: string;
}
export declare class MultiStreamJoiner {
  private options;
  private correlationCounter;
  private temporalWindow;
  constructor(options: MultiStreamJoinerOptions);
  cleanup(): void;
  joinMultiple(
    streams: Array<{
      name: string;
      stream: AsyncIterable<LogEvent>;
    }>
  ): AsyncGenerator<CorrelatedEvent>;
  private processStream;
  private extractJoinKey;
  private findMultiStreamCorrelations;
  private shouldIncludeCorrelation;
  private applyTemporalFilter;
  private applyFilter;
  private createCorrelation;
}
//# sourceMappingURL=multi-stream-joiner.d.ts.map
