import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface ConnectionPoolOptions {
  maxConnections?: number;
  maxConnectionsPerHost?: number;
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  timeout?: number;
  maxFreeSockets?: number;
  scheduling?: "fifo" | "lifo";
}

export interface ProxyConfig {
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

/**
 * Manages HTTP/HTTPS connection pooling for improved performance
 */
export class ConnectionPool {
  private httpAgent: HttpAgent;
  private httpsAgent: HttpsAgent;
  private proxyAgent?: SocksProxyAgent;
  private activeConnections: Map<string, number>;
  private connectionLimit: number;
  private hostLimit: number;
  private requestQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    host: string;
  }>;

  constructor(options: ConnectionPoolOptions = {}, proxy?: ProxyConfig) {
    const {
      maxConnections = 50,
      maxConnectionsPerHost = 10,
      keepAlive = true,
      keepAliveMsecs = 1000,
      timeout = 30000,
      maxFreeSockets = 10,
      scheduling = "fifo",
    } = options;

    this.connectionLimit = maxConnections;
    this.hostLimit = maxConnectionsPerHost;
    this.activeConnections = new Map();
    this.requestQueue = [];

    // Configure HTTP agent with connection pooling
    this.httpAgent = new HttpAgent({
      keepAlive,
      keepAliveMsecs,
      maxSockets: maxConnectionsPerHost,
      maxFreeSockets,
      timeout,
      scheduling,
    });

    // Configure HTTPS agent with connection pooling
    this.httpsAgent = new HttpsAgent({
      keepAlive,
      keepAliveMsecs,
      maxSockets: maxConnectionsPerHost,
      maxFreeSockets,
      timeout,
      scheduling,
    });

    // Configure proxy agent if needed
    if (proxy) {
      const proxyUrl = `${proxy.host}:${proxy.port}`;
      this.proxyAgent = new SocksProxyAgent(proxyUrl, {
        keepAlive,
        keepAliveMsecs,
        maxSockets: maxConnectionsPerHost,
        maxFreeSockets,
        timeout,
      });

      if (proxy.auth) {
        this.proxyAgent.proxy.userId = proxy.auth.username;
        this.proxyAgent.proxy.password = proxy.auth.password;
      }
    }
  }

  /**
   * Get the appropriate agent for a URL
   */
  getAgent(url: string): HttpAgent | HttpsAgent | SocksProxyAgent {
    if (this.proxyAgent) {
      return this.proxyAgent;
    }

    return url.startsWith("https://") ? this.httpsAgent : this.httpAgent;
  }

  /**
   * Acquire a connection slot
   */
  async acquireConnection(host: string): Promise<void> {
    const currentTotal = this.getTotalConnections();
    const currentHost = this.activeConnections.get(host) || 0;

    // Check limits
    if (currentTotal >= this.connectionLimit || currentHost >= this.hostLimit) {
      // Queue the request
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ resolve, reject, host });
      });
    }

    // Increment connection count
    this.activeConnections.set(host, currentHost + 1);
  }

  /**
   * Release a connection slot
   */
  releaseConnection(host: string): void {
    const current = this.activeConnections.get(host) || 0;
    if (current > 0) {
      this.activeConnections.set(host, current - 1);
      if (current - 1 === 0) {
        this.activeConnections.delete(host);
      }
    }

    // Process queued requests
    this.processQueue();
  }

  /**
   * Process queued connection requests
   */
  private processQueue(): void {
    if (this.requestQueue.length === 0) return;

    const totalConnections = this.getTotalConnections();
    
    for (let i = 0; i < this.requestQueue.length; i++) {
      const request = this.requestQueue[i];
      const hostConnections = this.activeConnections.get(request.host) || 0;

      if (totalConnections < this.connectionLimit && hostConnections < this.hostLimit) {
        // Remove from queue and process
        this.requestQueue.splice(i, 1);
        this.activeConnections.set(request.host, hostConnections + 1);
        request.resolve();
        i--; // Adjust index after removal
      }
    }
  }

  /**
   * Get total active connections
   */
  private getTotalConnections(): number {
    let total = 0;
    for (const count of this.activeConnections.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    activeConnections: number;
    queuedRequests: number;
    connectionsByHost: Map<string, number>;
  } {
    return {
      activeConnections: this.getTotalConnections(),
      queuedRequests: this.requestQueue.length,
      connectionsByHost: new Map(this.activeConnections),
    };
  }

  /**
   * Close all connections
   */
  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    if (this.proxyAgent) {
      this.proxyAgent.destroy();
    }

    // Reject all queued requests
    for (const request of this.requestQueue) {
      request.reject(new Error("Connection pool destroyed"));
    }
    this.requestQueue = [];
    this.activeConnections.clear();
  }

  /**
   * Reset the connection pool
   */
  reset(): void {
    // Clear active connections tracking
    this.activeConnections.clear();
    
    // Process any queued requests
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (request) {
        request.resolve();
      }
    }
  }
}