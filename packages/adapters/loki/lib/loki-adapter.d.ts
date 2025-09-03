import { DataSourceAdapter, LogEvent } from "@timebridge/core";
export interface LokiAdapterOptions {
  url: string;
  websocket?: boolean;
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  authToken?: string;
  headers?: Record<string, string>;
}
export declare class LokiAdapter implements DataSourceAdapter {
  private options;
  private ws?;
  private activeStreams;
  private reconnectAttempts;
  private heartbeatInterval?;
  private reconnectTimeout?;
  private wsConnectionPromise?;
  constructor(options: LokiAdapterOptions);
  getName(): string;
  createStream(query: string, options?: unknown): AsyncIterable<LogEvent>;
  private createWebSocketStream;
  private connectAndStream;
  private setupHeartbeat;
  private resetHeartbeat;
  private clearHeartbeat;
  private createPollingStream;
  private parseLogEntry;
  private extractJoinKeys;
  private buildHeaders;
  validateQuery(query: string): boolean;
  getAvailableStreams(): Promise<string[]>;
  destroy(): Promise<void>;
}
//# sourceMappingURL=loki-adapter.d.ts.map
