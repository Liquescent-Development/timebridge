import { EventEmitter } from "eventemitter3";

export interface PerformanceMetrics {
  eventsProcessed: number;
  correlationsFound: number;
  averageLatency: number;
  throughput: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  errors: number;
  startTime: number;
  uptime: number;
}

export class PerformanceMonitor extends EventEmitter {
  private metrics: PerformanceMetrics;
  private latencies: number[] = [];
  private lastThroughputCheck: number;
  private lastEventCount: number = 0;
  private monitoringInterval?: NodeJS.Timeout;

  constructor(private intervalMs: number = 5000) {
    super();
    const now = Date.now();
    this.metrics = {
      eventsProcessed: 0,
      correlationsFound: 0,
      averageLatency: 0,
      throughput: 0,
      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0,
      },
      errors: 0,
      startTime: now,
      uptime: 0,
    };
    this.lastThroughputCheck = now;
  }

  start(): void {
    if (this.monitoringInterval) {
      return;
    }

    this.monitoringInterval = setInterval(() => {
      this.updateMetrics();
      this.emit("metrics", this.getMetrics());
    }, this.intervalMs);

    // Ensure the interval doesn't keep the process alive during tests
    if (
      this.monitoringInterval &&
      typeof this.monitoringInterval.unref === "function"
    ) {
      this.monitoringInterval.unref();
    }
  }

  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  recordEvent(startTime: number): void {
    this.metrics.eventsProcessed++;
    const latency = Date.now() - startTime;
    this.latencies.push(latency);

    // Keep only last 1000 latencies to avoid memory growth
    if (this.latencies.length > 1000) {
      this.latencies.shift();
    }
  }

  recordCorrelation(): void {
    this.metrics.correlationsFound++;
  }

  recordError(): void {
    this.metrics.errors++;
  }

  private updateMetrics(): void {
    const now = Date.now();

    // Update uptime
    this.metrics.uptime = now - this.metrics.startTime;

    // Calculate average latency
    if (this.latencies.length > 0) {
      const sum = this.latencies.reduce((a, b) => a + b, 0);
      this.metrics.averageLatency = sum / this.latencies.length;
    }

    // Calculate throughput (events per second)
    const timeDiff = (now - this.lastThroughputCheck) / 1000;
    const eventDiff = this.metrics.eventsProcessed - this.lastEventCount;
    this.metrics.throughput = eventDiff / timeDiff;

    this.lastThroughputCheck = now;
    this.lastEventCount = this.metrics.eventsProcessed;

    // Update memory usage
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsage = {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
    };

    // Check for high memory usage
    const memoryMB = memUsage.heapUsed / 1024 / 1024;
    if (memoryMB > 100) {
      this.emit("highMemoryUsage", { usedMB: memoryMB });
    }

    // Check for performance issues
    if (this.metrics.averageLatency > 100) {
      this.emit("highLatency", { averageMs: this.metrics.averageLatency });
    }

    if (this.metrics.throughput < 10 && this.metrics.eventsProcessed > 100) {
      this.emit("lowThroughput", { eventsPerSecond: this.metrics.throughput });
    }
  }

  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  reset(): void {
    const now = Date.now();
    this.metrics = {
      eventsProcessed: 0,
      correlationsFound: 0,
      averageLatency: 0,
      throughput: 0,
      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0,
      },
      errors: 0,
      startTime: now,
      uptime: 0,
    };
    this.latencies = [];
    this.lastThroughputCheck = now;
    this.lastEventCount = 0;
  }
}
