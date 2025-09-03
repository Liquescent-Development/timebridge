// Electron application integration example
const { TimeBridgeEngine } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");
const { GraylogAdapter } = require("@timebridge/graylog");

// This would typically be in your Electron main or renderer process
class IDETimeBridgeEngine {
  constructor(config = {}) {
    this.engine = new TimeBridgeEngine({
      defaultTimeWindow: config.defaultTimeWindow || "5m",
      maxEvents: config.maxEvents || 10000,
      lateTolerance: config.lateTolerance || "30s",
      maxMemoryMB: config.maxMemoryMB || 100,
    });

    // Track active queries for cancellation
    this.activeQueries = new Map();

    // Setup event listeners
    this.setupEventListeners();

    // Register adapters based on config
    if (config.lokiUrl) {
      this.engine.addAdapter(
        "loki",
        new LokiAdapter({
          url: config.lokiUrl,
          websocket: config.lokiWebsocket !== false,
          authToken: config.lokiToken,
        })
      );
    }

    if (config.graylogUrl) {
      this.engine.addAdapter(
        "graylog",
        new GraylogAdapter({
          url: config.graylogUrl,
          username: config.graylogUser,
          password: config.graylogPassword,
          apiToken: config.graylogToken,
          apiVersion: config.graylogApiVersion || "legacy", // Use "v6" for Graylog 6.x+
        })
      );
    }
  }

  setupEventListeners() {
    // Listen for correlation events
    this.engine.on("correlationFound", (correlation) => {
      // In Electron, you might send this to the renderer process
      this.sendToRenderer("correlation-found", correlation);
    });

    this.engine.on("memoryWarning", (info) => {
      console.warn("Memory warning:", info);
      this.sendToRenderer("memory-warning", info);
    });
  }

  async executeQuery(queryId, queryText, options = {}) {
    console.log(`Executing query ${queryId}: ${queryText}`);

    const results = [];
    const startTime = Date.now();

    // Store query for potential cancellation
    const abortController = new AbortController();
    this.activeQueries.set(queryId, abortController);

    try {
      // Validate query first
      if (!this.engine.validateQuery(queryText)) {
        throw new Error("Invalid query syntax");
      }

      // Execute correlation
      for await (const correlation of this.engine.correlate(queryText)) {
        // Check if query was cancelled
        if (abortController.signal.aborted) {
          break;
        }

        results.push(correlation);

        // Send real-time results to UI
        this.sendToRenderer("correlation-result", {
          queryId,
          correlation,
          isPartial: true,
        });

        // Apply result limit if specified
        if (options.maxResults && results.length >= options.maxResults) {
          break;
        }
      }

      const duration = Date.now() - startTime;

      // Send final results
      this.sendToRenderer("query-complete", {
        queryId,
        results,
        duration,
        count: results.length,
      });

      return {
        success: true,
        results,
        duration,
        count: results.length,
      };
    } catch (error) {
      console.error(`Query ${queryId} failed:`, error);

      this.sendToRenderer("query-error", {
        queryId,
        error: error.message,
        code: error.code,
      });

      return {
        success: false,
        error: error.message,
        code: error.code,
      };
    } finally {
      this.activeQueries.delete(queryId);
    }
  }

  cancelQuery(queryId) {
    const controller = this.activeQueries.get(queryId);
    if (controller) {
      controller.abort();
      this.activeQueries.delete(queryId);
      console.log(`Query ${queryId} cancelled`);
      return true;
    }
    return false;
  }

  // Helper method for UI to validate queries
  async validateQuery(query) {
    try {
      const isValid = this.engine.validateQuery(query);
      return { valid: isValid };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  // Get available streams for autocomplete
  async getAvailableStreams(source) {
    const adapter = this.engine.getAdapter(source);
    if (!adapter) {
      return [];
    }

    try {
      return await adapter.getAvailableStreams();
    } catch (error) {
      console.error(`Failed to get streams for ${source}:`, error);
      return [];
    }
  }

  // Get adapter status
  getAdapterStatus() {
    const adapters = [];

    for (const [name, adapter] of this.engine.adapters) {
      adapters.push({
        name,
        type: adapter.getName(),
        connected: true, // Could implement actual health checks
      });
    }

    return adapters;
  }

  // Simulate sending to renderer process (in real Electron app)
  sendToRenderer(channel, data) {
    // In a real Electron app, you would use:
    // mainWindow.webContents.send(channel, data);

    // For this example, just log it
    console.log(`[IPC] ${channel}:`, JSON.stringify(data, null, 2));
  }

  async destroy() {
    // Cancel all active queries
    for (const [queryId, controller] of this.activeQueries) {
      controller.abort();
    }
    this.activeQueries.clear();

    // Destroy engine
    await this.engine.destroy();
  }
}

// Example usage
async function main() {
  console.log("Electron Integration Example");
  console.log("============================\n");

  // Initialize with configuration (would come from app settings)
  const correlationEngine = new IDETimeBridgeEngine({
    lokiUrl: "http://localhost:3100",
    lokiWebsocket: true,
    graylogUrl: "http://localhost:9000",
    graylogUser: "admin",
    graylogPassword: "admin",
    graylogApiVersion: "legacy", // Change to "v6" for Graylog 6.x+
    defaultTimeWindow: "5m",
    maxEvents: 10000,
    maxMemoryMB: 100,
  });

  // Example 1: Execute a query with real-time updates
  console.log("Executing correlation query...\n");

  const queryId = "query_" + Date.now();
  const query = `
    loki({service="frontend"})[5m] 
      and on(request_id) 
      loki({service="backend"})[5m]
  `;

  const result = await correlationEngine.executeQuery(queryId, query, {
    maxResults: 100,
  });

  console.log(`\nQuery completed: ${result.success}`);
  if (result.success) {
    console.log(`  Found ${result.count} correlations in ${result.duration}ms`);
  }

  // Example 2: Validate a query
  console.log("\nValidating queries...");

  const validQuery =
    'loki({service="test"})[1m] and on(id) graylog(level:error)[1m]';
  const invalidQuery = "this is not valid";

  const validation1 = await correlationEngine.validateQuery(validQuery);
  console.log(`  Valid query: ${validation1.valid}`);

  const validation2 = await correlationEngine.validateQuery(invalidQuery);
  console.log(`  Invalid query: ${validation2.valid} (${validation2.error})`);

  // Example 3: Get available streams
  console.log("\nFetching available streams...");

  const lokiStreams = await correlationEngine.getAvailableStreams("loki");
  console.log(
    `  Loki streams: ${
      lokiStreams.length > 0 ? lokiStreams.join(", ") : "none"
    }`
  );

  // Example 4: Check adapter status
  console.log("\nAdapter status:");
  const adapters = correlationEngine.getAdapterStatus();
  adapters.forEach((adapter) => {
    console.log(
      `  ${adapter.name}: ${adapter.connected ? "connected" : "disconnected"}`
    );
  });

  // Clean up
  await correlationEngine.destroy();
  console.log("\nEngine destroyed successfully");
}

// Run the example
main().catch(console.error);
