import { DataSourceAdapter, LogEvent } from "@timebridge/core";
export interface GraylogAdapterOptions {
  url: string;
  username?: string;
  password?: string;
  apiToken?: string;
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  streamId?: string;
}
export declare class GraylogAdapter implements DataSourceAdapter {
  private options;
  private activeStreams;
  private authHeader;
  constructor(options: GraylogAdapterOptions);
  getName(): string;
  createStream(query: string, options?: unknown): AsyncIterable<LogEvent>;
  private createPollingStream;
  private search;
  private parseGraylogMessage;
  private extractJoinKeys;
  private convertToGraylogQuery;
  private parseTimeRange;
  validateQuery(query: string): boolean;
  getAvailableStreams(): Promise<string[]>;
  destroy(): Promise<void>;
}
//# sourceMappingURL=graylog-adapter.d.ts.map
