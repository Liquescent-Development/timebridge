export declare function parseTimeWindow(window: string): number;
export declare function formatDuration(ms: number): string;
export declare function generateCorrelationId(): string;
export declare function isValidTimestamp(timestamp: string): boolean;
export declare function extractLabels(logLine: string): Record<string, string>;
export declare function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void;
//# sourceMappingURL=utils.d.ts.map
