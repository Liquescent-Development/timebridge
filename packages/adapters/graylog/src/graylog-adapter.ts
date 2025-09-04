import {
  DataSourceAdapter,
  LogEvent,
  CorrelationError,
} from "@timebridge/core";
import fetch, { RequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import { GraylogParser } from "./graylog-parser";
import { logger, streamLogger, csvLogger, apiLogger, queryLogger } from "./logger";
import { parse } from 'csv-parse';
import { Transform } from 'stream';

export interface GraylogAdapterOptions {
  url: string;
  username?: string;
  password?: string;
  apiToken?: string;
  pollInterval?: number;
  timeout?: number;
  maxRetries?: number;
  maxResults?: number; // Maximum results per search query (default: 10000)
  streamId?: string; // MongoDB ObjectId of the stream (24 hex chars)
  streamName?: string; // Human-readable stream name (will be resolved to ID)
  apiVersion?: "legacy" | "v6"; // 'legacy' for universal search, 'v6' for views API
  fields?: string[]; // Specific fields to request (omit to get all fields)
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    type?: 4 | 5; // SOCKS4 or SOCKS5, defaults to 5
  };
}

interface GraylogMessage {
  message: string;
  timestamp: string;
  source: string;
  fields: Record<string, unknown>;
  _id: string;
}

interface GraylogSearchResponse {
  messages: Array<{
    message: GraylogMessage;
    index: string;
  }>;
  total_results: number;
  from: string;
  to: string;
}

// Graylog 6.x views API response format
// Currently unused but kept for future enhancements
// interface GraylogViewsMessage {
//   _id: string;
//   timestamp: string;
//   message: string;
//   source?: string;
//   [key: string]: unknown; // Additional fields
// }

// Note: GraylogViewsSearchRequest interface removed as we're using
// the simpler /api/views/search/messages format which is different
// from the complex views/search/sync endpoint

export class GraylogAdapter implements DataSourceAdapter {
  private activeStreams: Set<AbortController> = new Set();
  private authHeader: string;
  private proxyAgent?: SocksProxyAgent;
  private resolvedStreamId?: string;
  private streamResolutionPromise?: Promise<void>;
  private parser: GraylogParser;
  private debugCounter: number = 0;
  private allFieldsCache?: string[];  // Cache the field list

  constructor(private options: GraylogAdapterOptions) {
    this.options = {
      pollInterval: 2000,
      timeout: 15000,
      maxRetries: 3,
      apiVersion: "legacy", // Default to legacy for backward compatibility
      ...options,
    };

    // Initialize parser
    this.parser = new GraylogParser({
      allowLeadingWildcards: false, // Can be made configurable via options
    });

    // Setup authentication
    if (options.apiToken) {
      this.authHeader = `token ${options.apiToken}`;
    } else if (options.username && options.password) {
      const credentials = Buffer.from(
        `${options.username}:${options.password}`
      ).toString("base64");
      this.authHeader = `Basic ${credentials}`;
    } else {
      throw new CorrelationError(
        "Graylog adapter requires either apiToken or username/password",
        "AUTH_REQUIRED"
      );
    }

    // Create SOCKS proxy agent if configured
    if (this.options.proxy) {
      const { host, port, username, password, type = 5 } = this.options.proxy;
      const auth = username && password ? `${username}:${password}@` : "";
      const proxyUrl = `socks${type}://${auth}${host}:${port}`;
      this.proxyAgent = new SocksProxyAgent(proxyUrl);
    }

    // Resolve stream name to ID if needed
    if (this.options.streamName && !this.options.streamId) {
      this.streamResolutionPromise = this.resolveStreamName();
    }
  }

  /**
   * Resolve stream name to stream ID
   */
  private async resolveStreamName(): Promise<void> {
    try {
      const url = `${this.options.url}/api/streams`;
      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
        agent: this.proxyAgent as any,
      });

      if (!response.ok) {
        apiLogger.warn({ status: response.statusText }, "Failed to fetch streams for name resolution");
        return;
      }

      const data = await response.json();
      const streams = data.streams || [];

      // Find stream by name (case-insensitive)
      const stream = streams.find(
        (s: any) =>
          s.title?.toLowerCase() === this.options.streamName?.toLowerCase() ||
          s.name?.toLowerCase() === this.options.streamName?.toLowerCase()
      );

      if (stream) {
        this.resolvedStreamId = stream.id;
        // Only log if we're not being destroyed (prevents "Cannot log after tests are done")
        if (this.activeStreams) {
          // Log success without revealing the stream name
          streamLogger.info("Successfully resolved stream");
        }
      } else {
        // Only warn if we're not being destroyed
        if (this.activeStreams) {
          // Don't log actual stream names for security reasons
          streamLogger.warn({ availableStreams: streams.length }, "Stream not found");
        }
      }
    } catch (error) {
      // Only warn if we're not being destroyed
      if (this.activeStreams) {
        streamLogger.warn({ error }, "Failed to resolve stream name");
      }
    }
  }

  /**
   * Get the effective stream ID (resolved from name or direct ID)
   */
  private async getEffectiveStreamId(): Promise<string | undefined> {
    // First check for request-specific stream ID
    // Note: explicitly check for non-null to avoid using empty string or false
    const requestStreamId = (this as any).requestStreamId;
    if (requestStreamId && requestStreamId !== null) {
      return requestStreamId;
    }
    
    // Wait for stream name resolution if in progress
    if (this.streamResolutionPromise) {
      await this.streamResolutionPromise;
      this.streamResolutionPromise = undefined; // Clear after resolution
    }

    // Return resolved ID or original streamId
    return this.resolvedStreamId || this.options.streamId;
  }
  
  /**
   * Get stream ID from stream name
   * This allows dynamic stream selection per query
   */
  private async getStreamIdFromName(streamName: string): Promise<string | undefined> {
    const url = `${this.options.url}/api/streams`;
    
    const fetchOptions: RequestInit = {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "X-Requested-By": "log-correlator",
      },
      agent: this.proxyAgent as any,
    };

    try {
      const response = await fetch(url, fetchOptions);
      
      if (!response.ok) {
        apiLogger.warn({ status: response.statusText }, "Failed to fetch streams");
        return undefined;
      }
      
      const data = await response.json();
      streamLogger.info({ availableStreams: data.streams?.map((s: any) => s.title) || [] }, "Available streams found");
      
      const stream = data.streams?.find((s: any) => 
        s.title === streamName || s.description === streamName
      );
      
      if (stream) {
        return stream.id;
      }
      
      streamLogger.warn({ streamName }, "Stream not found among available streams");
      return undefined;
    } catch (error) {
      apiLogger.warn({ error }, "Error fetching streams");
      return undefined;
    }
  }

  getName(): string {
    return "graylog";
  }

  async *createStream(
    query: string,
    options?: unknown
  ): AsyncIterable<LogEvent> {
    const opts =
      (options as { 
        timeRange?: string; 
        continuous?: boolean; 
        correlationKeys?: string[]; 
        sourceName?: string; 
        streamName?: string;
        abortSignal?: AbortSignal;
        bloomFilter?: any;
      }) || {};
    const timeRange = opts.timeRange || "5m";
    const continuous = opts.continuous === true; // Default to false for correlation queries
    const correlationKeys = opts.correlationKeys;
    const sourceName = opts.sourceName;
    const streamName = opts.streamName;
    const abortSignal = opts.abortSignal;
    const bloomFilter = opts.bloomFilter;

    // Store options for field optimization
    if (sourceName) {
      (this as any).sourceName = sourceName;
    }
    if (correlationKeys) {
      (this as any).correlationKeys = correlationKeys;
    }
    // Store or clear the abort signal - important to clear it for batched queries
    (this as any).abortSignal = abortSignal || null;
    if (bloomFilter) {
      (this as any).bloomFilter = bloomFilter;
    }
    
    // Look up stream ID if a specific stream is provided
    let requestStreamId: string | undefined;
    if (streamName) {
      streamLogger.info({ streamName }, "Looking up stream");
      // Look up the stream ID from the stream name
      requestStreamId = await this.getStreamIdFromName(streamName);
      if (requestStreamId) {
        streamLogger.info({ streamName, streamId: requestStreamId }, "Found stream with ID");
      } else {
        streamLogger.warn({ streamName }, "Stream not found, proceeding without stream filter");
      }
    }
    
    // Store or clear the stream ID for this request
    // IMPORTANT: Clear it when no stream is specified to avoid using stale stream IDs
    (this as any).requestStreamId = requestStreamId || null;

    if (continuous) {
      // For real-time monitoring, poll continuously
      yield* this.createPollingStream(query, timeRange);
    } else {
      // For correlation queries with time windows, fetch historical data once
      // This aligns with LogQL/PromQL semantics where [5m] means "last 5 minutes of data"
      yield* this.createHistoricalStream(query, timeRange);
    }
  }


  private async *createHistoricalStream(
    query: string,
    timeRange: string
  ): AsyncIterable<LogEvent> {
    const controller = new AbortController();
    this.activeStreams.add(controller);

    try {
      const timeWindowMs = this.parseTimeRange(timeRange);
      const now = new Date();
      const from = new Date(now.getTime() - timeWindowMs);

      // Get effective stream ID once at the start
      const effectiveStreamId = await this.getEffectiveStreamId();

      if (this.options.apiVersion === "v6") {
        // V6 API: Single request that exports all messages (no pagination)
        // The API will return all messages matching the query up to the limit
        const limit = this.options.maxResults || 100000000; // Default to 100M for DuckDB scale
        
        queryLogger.info({ limit, timeRange }, "Fetching messages from time window");
        
        // Optimize fields if correlation keys are provided
        let fieldsParam = "_id,message,timestamp,source,*";
        if ((this as any).correlationKeys && (this as any).correlationKeys.length > 0) {
          const correlationKeys = (this as any).correlationKeys as string[];
          fieldsParam = "_id,message,timestamp,source," + correlationKeys.join(",");
          queryLogger.debug({ fields: fieldsParam }, "Optimized fields for correlation");
        }

        const searchParams: Record<string, unknown> = {
          query: query,
          from: from.toISOString(),
          to: now.toISOString(),
          limit: limit,  // This is the total limit, not per-page
          sort: "timestamp:asc",
          fields: fieldsParam,
          range: Math.floor(timeWindowMs / 1000),
        };

        if (effectiveStreamId) {
          searchParams["filter"] = `streams:${effectiveStreamId}`;
        }

        try {
          // For v6, we need to handle the CSV response in a streaming manner
          // to avoid loading all messages into memory at once
          let messageCount = 0;
          const batchSize = 1000; // Yield messages in batches for better performance
          let batch: LogEvent[] = [];
          const startTime = Date.now();
          let firstMessageTime: number | null = null;
          
          // Use the streaming version of searchViews for v6
          for await (const messageWrapper of this.searchViewsStreaming(searchParams, controller.signal)) {
            messageCount++;
            
            // Check abort signal AFTER incrementing count but allow message processing
            // This ensures that messages already yielded from searchViewsStreaming are processed
            // NOTE: We only check abort signal if it was explicitly set (not for batched queries)
            const abortSignal = (this as any).abortSignal as AbortSignal | undefined;
            
            // Debug first message
            if (messageCount === 1) {
              firstMessageTime = Date.now();
              const timeToFirstMessage = firstMessageTime - startTime;
              console.log(`[Graylog v6] Time to first message: ${timeToFirstMessage}ms`);
              
              const msg = messageWrapper.message;
              console.log(`[Debug] First message structure:`);
              console.log(`  - Has fields: ${msg.fields ? 'yes' : 'no'}`);
              console.log(`  - Direct keys: ${Object.keys(msg).slice(0, 10).join(', ')}`);
              if (msg.fields) {
                console.log(`  - Field keys: ${Object.keys(msg.fields).slice(0, 10).join(', ')}`);
                if (msg.fields.request_id !== undefined) {
                  console.log(`  - request_id in fields: "${msg.fields.request_id}"`);
                }
              }
            }
            
            // Parse the message
            const parsedEvent = this.parseGraylogMessage(messageWrapper.message);
            
            // Apply Bloom filter if present
            const bloomFilter = (this as any).bloomFilter;
            if (bloomFilter && bloomFilter.mightContain) {
              const correlationKeys = (this as any).correlationKeys as string[] | undefined;
              if (correlationKeys && correlationKeys.length > 0) {
                // Check if any correlation key matches the Bloom filter
                let shouldInclude = false;
                for (const key of correlationKeys) {
                  const value = parsedEvent.labels?.[key] || parsedEvent.joinKeys?.[key];
                  if (value && bloomFilter.mightContain(String(value))) {
                    shouldInclude = true;
                    break;
                  }
                }
                
                if (!shouldInclude) {
                  // Skip this message as it doesn't match the Bloom filter
                  continue;
                }
              }
            }
            
            // Add to batch instead of yielding immediately
            batch.push(parsedEvent);
            
            // Yield batch when it reaches batchSize
            if (batch.length >= batchSize) {
              for (const event of batch) {
                yield event;
              }
              batch = [];
            }
            
            // Check abort signal AFTER processing the message
            // This allows messages from batched queries to be processed before aborting
            if (abortSignal?.aborted) {
              console.log(`[Graylog v6] Stream aborted for optimization after ${messageCount} messages`);
              // Still yield any remaining messages in the batch before breaking
              for (const event of batch) {
                yield event;
              }
              break;
            }
            
            // Progress indicator with memory monitoring and throughput
            if (messageCount % 10000 === 0) {
              const elapsed = Date.now() - startTime;
              const throughput = Math.round(messageCount / (elapsed / 1000));
              const memUsage = process.memoryUsage();
              console.log(`[Graylog v6] Streamed ${messageCount} messages in ${elapsed}ms (${throughput} msg/s), ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap used`);
            }
          }
          
          // Yield any remaining messages in the batch
          for (const event of batch) {
            yield event;
          }
          
          const totalTime = Date.now() - startTime;
          const avgThroughput = Math.round(messageCount / (totalTime / 1000));
          console.log(`Graylog v6: Streamed total of ${messageCount} messages in ${totalTime}ms (avg ${avgThroughput} msg/s)`);
          
          if (messageCount === 0) {
            console.log(`Graylog v6: No messages found for ${timeRange} window`);
          }
        } catch (error) {
          console.error("Graylog search error:", error);
          throw error;
        }
      } else {
        // Non-v6 API: Use offset-based pagination
        const batchSize = 10000;
        let offset = 0;
        let totalFetched = 0;
        let hasMore = true;
        
        if (this.options.maxResults) {
          console.log(`[Graylog] Will fetch up to ${this.options.maxResults} messages from ${timeRange} window`);
        } else {
          console.log(`[Graylog] Will fetch ALL messages from ${timeRange} window (no limit)`);
        }

        while (hasMore && !controller.signal.aborted) {
          // Optimize fields if correlation keys are provided
          let fieldsParam = "_id,message,timestamp,source,*";
          if ((this as any).correlationKeys && (this as any).correlationKeys.length > 0) {
            const correlationKeys = (this as any).correlationKeys as string[];
            fieldsParam = "_id,message,timestamp,source," + correlationKeys.join(",");
          }

          const searchParams: Record<string, unknown> = {
            query: this.convertToGraylogQuery(query),
            from: from.toISOString(),
            to: now.toISOString(),
            limit: batchSize,
            offset: offset,
            sort: "timestamp:asc",
            fields: fieldsParam,
          };
          
          if (effectiveStreamId) {
            searchParams["filter"] = `streams:${effectiveStreamId}`;
          }

          try {
            const response = await this.search(searchParams, controller.signal);

            if (response.messages && response.messages.length > 0) {
              if (offset === 0) {
                console.log(`Graylog: Fetched ${response.messages.length} messages for ${timeRange} window`);
              } else {
                console.log(`Graylog: Fetched additional ${response.messages.length} messages (offset ${offset})`);
              }
              
              totalFetched += response.messages.length;
              
              for (const msg of response.messages) {
                yield this.parseGraylogMessage(msg.message);
              }
              
              // Check if we should continue paginating
              if (response.messages.length < batchSize) {
                hasMore = false;
                console.log(`Graylog: Reached end of results (got ${response.messages.length} in last batch)`);
              } else if (this.options.maxResults && totalFetched >= this.options.maxResults) {
                hasMore = false;
                console.log(`Graylog: Stopped at configured limit of ${this.options.maxResults} messages`);
              } else {
                offset += batchSize;
                if (totalFetched % 50000 === 0) {
                  console.log(`Graylog: Fetching more data (${totalFetched} messages so far)...`);
                }
              }
            } else {
              hasMore = false;
              if (offset === 0) {
                console.log(`Graylog: No messages found for ${timeRange} window`);
              } else {
                console.log(`Graylog: Reached end of results at offset ${offset} (empty response)`);
              }
            }
          } catch (error) {
            console.error("Graylog search error:", error);
            throw error;
          }
        }
        
        if (totalFetched > batchSize) {
          console.log(`Graylog: Total fetched ${totalFetched} messages for ${timeRange} window`);
        }
      }
    } finally {
      this.activeStreams.delete(controller);
    }
  }

  private async *createPollingStream(
    query: string,
    timeRange: string
  ): AsyncIterable<LogEvent> {
    const controller = new AbortController();
    this.activeStreams.add(controller);

    try {
      let lastMessageId: string | null = null;
      const timeWindowMs = this.parseTimeRange(timeRange);

      // Get effective stream ID once at the start
      const effectiveStreamId = await this.getEffectiveStreamId();

      while (!controller.signal.aborted) {
        const now = new Date();
        const from = new Date(now.getTime() - timeWindowMs);

        // Optimize fields if correlation keys are provided
        let fieldsParam = "_id,message,timestamp,source,*";
        if ((this as any).correlationKeys && (this as any).correlationKeys.length > 0) {
          const correlationKeys = (this as any).correlationKeys as string[];
          fieldsParam = "_id,message,timestamp,source," + correlationKeys.join(",");
          console.log(`[Graylog] Optimized fields for polling: ${fieldsParam}`);
        }

        const searchParams: Record<string, unknown> = {
          query:
            this.options.apiVersion === "v6"
              ? query
              : this.convertToGraylogQuery(query),
          from: from.toISOString(),
          to: now.toISOString(),
          limit: this.options.maxResults || 10000,  // Use configurable limit, default 10000
          sort: "timestamp:asc",  // Get oldest events first to ensure consistent time coverage
          fields: fieldsParam,
          range: Math.floor(timeWindowMs / 1000), // Add range in seconds for v6
        };

        if (effectiveStreamId) {
          searchParams["filter"] = `streams:${effectiveStreamId}`;
        }

        try {
          const response = await this.search(searchParams, controller.signal);

          if (response.messages && response.messages.length > 0) {
            let newMessages = response.messages;

            // Filter out messages we've already seen
            if (lastMessageId) {
              const lastIndex = newMessages.findIndex(
                (m) => m.message._id === lastMessageId
              );
              if (lastIndex >= 0) {
                newMessages = newMessages.slice(lastIndex + 1);
              }
            }

            for (const msg of newMessages) {
              yield this.parseGraylogMessage(msg.message);
              lastMessageId = msg.message._id;
            }
          }

        } catch (error) {
          if (controller.signal.aborted) break;
          console.error("Graylog polling error:", error);

          // Retry with exponential backoff - check for abort signal
          await new Promise((resolve) => {
            if (controller.signal.aborted) return resolve(undefined);

            const timeoutId = setTimeout(
              resolve,
              this.options.pollInterval! * 2
            );

            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeoutId);
                resolve(undefined);
              },
              { once: true }
            );
          });
        }

        // Break if aborted before the wait period
        if (controller.signal.aborted) break;

        // Wait before next poll - check for abort signal
        await new Promise((resolve) => {
          if (controller.signal.aborted) return resolve(undefined);

          const timeoutId = setTimeout(resolve, this.options.pollInterval);

          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeoutId);
              resolve(undefined);
            },
            { once: true }
          );
        });
      }
    } finally {
      this.activeStreams.delete(controller);
    }
  }

  /**
   * Stream parsed CSV data as LogEvent objects
   * This is used for direct batched ingestion into DuckDB
   */
  async *streamCSVAsEvents(
    query: string,
    timeRange: string,
    joinKeys: string[] = [],
    sourceName?: string
  ): AsyncIterable<LogEvent> {
    const parsedQuery = this.parser.parse(query);
    const queryFields = this.extractFieldsFromQuery(parsedQuery as any);
    
    const requestBody = this.buildGraylogV6Request(
      parsedQuery as any,
      timeRange,
      queryFields,
      query
    );

    csvLogger.debug({ requestedFields: queryFields }, "Parsed Graylog query");
    csvLogger.debug({ url: `${this.options.url}/api/views/search/messages`, requestBody }, "Executing CSV stream request");
    
    const url = `${this.options.url}/api/views/search/messages`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "text/csv",
      "Content-Type": "application/json",
      "X-Requested-By": "log-correlator"
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      agent: this.proxyAgent as any,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      csvLogger.error({ status: response.status, body: errorBody }, "CSV export failed");
      throw new CorrelationError(
        `CSV export failed: ${response.status}`,
        'GRAYLOG_CSV_ERROR',
        { status: response.status, body: errorBody }
      );
    }

    const body = response.body;
    if (!body) {
      throw new Error("No response body");
    }

    // Create CSV parser that outputs objects
    const csvParser = parse({
      columns: true, // Parse to objects with column names as keys
      delimiter: ',',
      quote: '"',
      escape: '"',
      skip_empty_lines: false,
      relax_quotes: true,
      relax_column_count: true,
      trim: false
    });

    // Track parsing state
    let recordCount = 0;
    let hasStarted = false;
    let hasEnded = false;
    let parseError: Error | null = null;
    
    // Set up error and end handlers
    csvParser.on('error', (err: Error) => {
      csvLogger.error({ error: err.message, stack: err.stack }, "CSV parser error");
      parseError = err;
    });
    
    csvParser.on('end', () => {
      hasEnded = true;
      csvLogger.debug({ recordCount }, "CSV parser ended");
    });
    
    // Log the response headers for debugging
    csvLogger.debug({ 
      contentType: response.headers.get('content-type'),
      contentEncoding: response.headers.get('content-encoding'),
      contentLength: response.headers.get('content-length')
    }, "Response headers");

    // Handle gzip if needed - but verify it's actually gzipped
    const isGzipped = response.headers.get('content-encoding') === 'gzip';
    if (isGzipped) {
      const zlib = require('zlib');
      const { Transform } = require('stream');
      
      // Create a transform stream that checks first chunk and routes accordingly
      let isActuallyGzipped: boolean | null = null;
      let gunzip: any = null;
      
      const inspector = new Transform({
        transform(chunk: Buffer, encoding: string, callback: (error?: Error | null) => void) {
          // Check if the stream has been destroyed before processing
          if (this.destroyed) {
            return callback();
          }
          
          if (isActuallyGzipped === null) {
            // First chunk - determine if actually gzipped
            csvLogger.debug({ 
              firstBytes: chunk.slice(0, 10).toString('hex'),
              bytesReceived: chunk.length,
              preview: chunk.slice(0, 100).toString()
            }, "First chunk received (gzipped response)");
            
            // Check if it starts with gzip magic number (1f 8b)
            isActuallyGzipped = chunk[0] === 0x1f && chunk[1] === 0x8b;
            
            if (isActuallyGzipped) {
              csvLogger.debug({}, "Actually gzipped, setting up decompression");
              // Actually gzipped, create gunzip stream
              gunzip = zlib.createGunzip();
              gunzip.on('error', (err: Error) => {
                csvLogger.error({ error: err.message }, "Gunzip error");
                this.destroy(err);
              });
              gunzip.pipe(csvParser);
            } else {
              csvLogger.debug({}, "Not actually gzipped despite header");
            }
          }
          
          // Route the chunk to the appropriate destination - with error handling
          try {
            if (isActuallyGzipped && gunzip) {
              if (!gunzip.destroyed) {
                gunzip.write(chunk, callback);
              } else {
                callback();
              }
            } else {
              if (!csvParser.destroyed) {
                csvParser.write(chunk, callback);
              } else {
                callback();
              }
            }
          } catch (err) {
            // If write fails due to destroyed stream, just continue
            callback();
          }
        },
        flush(callback: (error?: Error | null) => void) {
          // End the appropriate stream - with error handling
          try {
            if (isActuallyGzipped && gunzip && !gunzip.destroyed) {
              gunzip.end();
            } else if (!isActuallyGzipped && !csvParser.destroyed) {
              csvParser.end();
            }
          } catch (err) {
            // Ignore errors during flush if stream is already destroyed
          }
          callback();
        }
      });
      
      inspector.on('error', (err: Error) => {
        csvLogger.error({ error: err.message }, "Inspector transform error");
        csvParser.destroy(err);
      });
      
      body.pipe(inspector);
    } else {
      csvLogger.debug({}, "Response is not gzipped, piping directly to CSV parser");
      
      // Add debugging for the body stream
      let bodyBytes = 0;
      let firstDataLogged = false;
      body.on('data', (chunk: any) => {
        bodyBytes += chunk.length;
        if (!firstDataLogged) {
          firstDataLogged = true;
          csvLogger.debug({ 
            chunkSize: chunk.length,
            totalBytes: bodyBytes,
            preview: chunk.slice(0, Math.min(200, chunk.length)).toString()
          }, "First body data received");
        }
      });
      
      body.on('end', () => {
        csvLogger.debug({ totalBytes: bodyBytes }, "Body stream ended");
      });
      
      body.on('error', (err: Error) => {
        csvLogger.error({ error: err.message }, "Body stream error");
      });
      
      body.pipe(csvParser);
    }

    // Wait for the stream to be ready and properly connected
    // For gzipped responses, we need to ensure the entire pipeline is set up
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Create a promise that resolves when we get the first data or an error
    const streamReady = new Promise<void>((resolve, reject) => {
      let resolved = false;
      
      const resolveOnce = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      
      // Resolve when parser is readable
      csvParser.once('readable', () => {
        csvLogger.debug({}, "CSV parser is readable");
        resolveOnce();
      });
      
      // Also resolve on first data event
      csvParser.once('data', () => {
        csvLogger.debug({}, "CSV parser received first data");
        // Put the data back since we're just checking
        csvParser.pause();
        resolveOnce();
      });
      
      // Reject on error
      csvParser.once('error', (err) => {
        csvLogger.error({ error: err.message }, "CSV parser error during setup");
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          csvLogger.warn({}, "Stream setup timeout - proceeding anyway");
          resolve();
        }
      }, 10000);
    });
    
    try {
      csvLogger.debug({}, "Waiting for CSV stream to be ready...");
      await streamReady;
      csvLogger.debug({}, "CSV stream is ready, starting iteration");
    } catch (setupError) {
      csvLogger.error({ error: setupError }, "Failed to set up CSV stream");
      throw setupError;
    }
    
    csvLogger.debug({}, "Starting to iterate over CSV records");

    // Convert CSV records to LogEvents
    try {
      // Resume the parser if we paused it
      if (csvParser.isPaused()) {
        csvParser.resume();
      }
      
      for await (const record of csvParser) {
        if (!hasStarted) {
          hasStarted = true;
          csvLogger.debug({ firstRecord: Object.keys(record).slice(0, 10) }, "First CSV record received");
        }
        
        recordCount++;
      // Extract standard fields
      const timestamp = record.timestamp || new Date().toISOString();
      const message = record.message || '';
      // Use the provided sourceName (adapter identifier) instead of CSV source field
      const source = sourceName || 'graylog';
      
      // Everything else goes into labels
      const labels: Record<string, any> = {};
      const eventJoinKeys: Record<string, any> = {};
      
      for (const [key, value] of Object.entries(record)) {
        if (key !== 'timestamp' && key !== 'message') {
          labels[key] = value;
          // Dynamically populate join keys based on query
          if (joinKeys.includes(key) && value) {
            eventJoinKeys[key] = value;
          }
        }
      }
      
      const event: LogEvent = {
        timestamp,
        source,
        message,
        labels,
        joinKeys: Object.keys(eventJoinKeys).length > 0 ? eventJoinKeys : undefined
      };
      
      yield event;
    }
    } catch (iterError) {
      csvLogger.error({ 
        error: iterError instanceof Error ? iterError.message : String(iterError),
        stack: iterError instanceof Error ? iterError.stack : undefined,
        recordCount,
        hasStarted,
        hasEnded,
        parseError: parseError ? (parseError as Error).message : undefined
      }, "Error iterating CSV records");
      
      // Re-throw to let the caller handle it
      throw iterError;
    } finally {
      csvLogger.debug({ 
        recordCount,
        hasStarted,
        hasEnded,
        parseError: parseError ? (parseError as Error).message : undefined 
      }, "CSV streaming completed");
    }
  }

  private buildGraylogV6Request(
    parsedQuery: any,
    timeRange: string,
    queryFields: string[],
    originalQuery?: string
  ): any {
    // Build the request body for Graylog v6 messages export API
    const timeRangeMs = this.parseTimeRange(timeRange);
    const requestBody: any = {
      query_string: {
        query_string: originalQuery || parsedQuery.query || "*"
      },
      timerange: {
        type: "relative",
        range: Math.floor(timeRangeMs / 1000) // Convert to seconds, use 'range' field
      },
      limit: this.options.maxResults || 10000000
    };
    
    // Add fields if specified
    if (this.options.fields) {
      if (this.options.fields.includes('*')) {
        requestBody.fields_in_order = ['*'];
      } else {
        const fieldsSet = new Set(this.options.fields);
        queryFields.forEach(field => fieldsSet.add(field));
        requestBody.fields_in_order = Array.from(fieldsSet);
      }
    }
    
    return requestBody;
  }

  private extractFieldsFromQuery(parsedQuery: any): string[] {
    // Extract field names from parsed query for optimization
    const fields: string[] = [];
    
    // For now, return basic correlation fields
    // This could be enhanced to parse the actual query structure
    fields.push('request_id', 'trace_id', 'correlation_id', 'session_id');
    
    return fields;
  }

  private async search(
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<GraylogSearchResponse> {
    if (this.options.apiVersion === "v6") {
      return this.searchViews(params, signal);
    } else {
      return this.searchUniversal(params, signal);
    }
  }

  private async searchUniversal(
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<GraylogSearchResponse> {
    const url = `${this.options.url}/api/search/universal/relative`;
    const queryParams = new URLSearchParams(params as Record<string, string>);

    const fetchOptions: RequestInit = {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "X-Requested-By": "log-correlator",
      },
      signal,
      agent: this.proxyAgent as any,
    };

    const response = await fetch(`${url}?${queryParams}`, fetchOptions);

    if (!response.ok) {
      throw new CorrelationError(
        `Graylog search failed: ${response.statusText}`,
        "GRAYLOG_SEARCH_ERROR",
        { status: response.status }
      );
    }

    return await response.json();
  }

  private async getAllFields(signal: AbortSignal): Promise<string[]> {
    // Return cached fields if available
    if (this.allFieldsCache) {
      return this.allFieldsCache;
    }
    
    const url = `${this.options.url}/api/system/fields?limit=0`;
    
    const fetchOptions: RequestInit = {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "X-Requested-By": "log-correlator",
      },
      signal,
      agent: this.proxyAgent as any,
    };

    try {
      const response = await fetch(url, fetchOptions);
      
      if (!response.ok) {
        console.warn(`[Graylog] Failed to fetch all fields: ${response.statusText}`);
        return [];
      }
      
      const data = await response.json();
      if (data.fields && Array.isArray(data.fields)) {
        console.log(`[Graylog] Found ${data.fields.length} available fields in the system`);
        this.allFieldsCache = data.fields;  // Cache for future use
        return data.fields;
      }
      
      return [];
    } catch (error) {
      console.warn("[Graylog] Error fetching system fields:", error);
      return [];
    }
  }

  private async *searchViewsStreaming(
    params: Record<string, unknown>,
    signal: AbortSignal
  ): AsyncGenerator<{ message: GraylogMessage; index: string }> {
    const url = `${this.options.url}/api/views/search/messages`;
    
    // Check if we also have an external abort signal for optimization
    // This is stored as a property when doing non-batched optimized queries
    const externalAbortSignal = (this as any).abortSignal as AbortSignal | undefined;
    
    // Create a combined abort controller that will abort on either signal
    const combinedController = new AbortController();
    
    // Listen to both signals
    const handleAbort = () => {
      console.log('[Graylog] Abort signal received, cancelling request...');
      combinedController.abort();
    };
    
    signal.addEventListener('abort', handleAbort);
    if (externalAbortSignal) {
      externalAbortSignal.addEventListener('abort', handleAbort);
    }
    
    // Clean up function for signal listeners
    const cleanup = () => {
      signal.removeEventListener('abort', handleAbort);
      if (externalAbortSignal) {
        externalAbortSignal.removeEventListener('abort', handleAbort);
      }
    };
    
    try {
      // Calculate time window in seconds for relative timerange
      const range = (params.range as number) || 300; // Default 5 minutes

      // Convert query for Graylog v6 - handle special cases
      let query = (params.query as string) || "";

      // Graylog v6 doesn't allow '*' as first character in WildcardQuery
      // Use empty string for "all messages" queries
      if (query === "*" || query === "") {
        query = "";
      } else {
        // Ensure the query is properly formatted for Graylog v6
        query = this.sanitizeQueryForV6(query);
      }

      // Debug: Log the actual query being sent
      console.log(`[Graylog v6] Sending query: "${query}"`);
      
      const requestedLimit = (params.limit as number) || 100000000;
      console.log(`[Graylog v6] Requesting up to ${requestedLimit} events`);
    
    // Graylog v6 views API expects this exact structure with nested query_string
    // This is an export endpoint that can stream millions of events
    const requestBody: any = {
      query_string: {
        query_string: query,
      },
      timerange: {
        type: "relative",
        range: range // seconds
      },
      limit: requestedLimit,  // Use the full requested limit - this endpoint can handle it!
      // Note: Not specifying chunk_size to let Graylog use its default
      // chunk_size appears to be constrained by OpenSearch's max_result_window (10K)
    };
    
    // Handle field specification
    if (this.options.fields && this.options.fields.length > 0) {
      // Check if user specified "*" to get all fields
      if (this.options.fields.length === 1 && this.options.fields[0] === "*") {
        // Fetch all available fields from the system
        const allFields = await this.getAllFields(signal);
        if (allFields.length > 0) {
          requestBody.fields_in_order = allFields;
          console.log(`[Graylog v6] Requesting all ${allFields.length} available fields`);
        } else {
          // Fallback: don't specify fields and warn
          console.warn(
            "[Graylog v6] Could not fetch field list. Only basic fields will be returned."
          );
        }
      } else {
        // Use the specified fields
        requestBody.fields_in_order = this.options.fields;
      }
    } else {
      // WARNING: Without specifying fields, Graylog v6 only returns basic fields
      console.warn(
        "[Graylog v6] No fields specified - only basic fields (timestamp, source, message) will be returned. " +
        "To enable correlation, configure the 'fields' option with ['*'] to get all fields or specify required fields."
      );
    }

    // Note: Graylog v6 views API doesn't support offset-based pagination
    // It's an export endpoint that streams all results up to the limit instead

    // Add streams filter if configured
    // Check if stream filter was passed in params (from v6 path)
    if (params.filter && typeof params.filter === 'string' && params.filter.startsWith('streams:')) {
      const streamId = params.filter.substring('streams:'.length);
      if (/^[a-f0-9]{24}$/i.test(streamId)) {
        requestBody.streams = [streamId];
        console.log(`[Graylog v6] Filtering to stream ID from params: ${streamId}`);
      }
    } else {
      // Fallback to checking for stream ID set on instance
      const effectiveStreamId = await this.getEffectiveStreamId();
      if (effectiveStreamId) {
        // Validate that streamId looks like a MongoDB ObjectId (24 hex characters)
        if (/^[a-f0-9]{24}$/i.test(effectiveStreamId)) {
          requestBody.streams = [effectiveStreamId];
          console.log(`[Graylog v6] Filtering to stream ID: ${effectiveStreamId}`);
        } else {
          // Don't log the actual stream ID for security reasons (CodeQL js/clear-text-logging)
          console.warn(
            `Warning: Invalid streamId format - must be 24 hex characters. Ignoring stream filter.`
          );
        }
      }
    }

      // Debug log the request
      console.log(`[Graylog v6] Request body:`, JSON.stringify(requestBody, null, 2));
      
      const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "text/csv", // v6 API returns CSV by default
          "X-Requested-By": "log-correlator",
        },
        body: JSON.stringify(requestBody),
        signal: combinedController.signal, // Use combined signal
        agent: this.proxyAgent as any,
      };

      const response = await fetch(url, fetchOptions);
      
      console.log(`[Graylog v6] Response status: ${response.status}`);
      console.log(`[Graylog v6] Response headers:`, Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        // Try to get error details from response body
        let errorDetails: any = { status: response.status };
        try {
          const errorText = await response.text();
          if (errorText) {
            try {
              errorDetails = JSON.parse(errorText);
            } catch {
              errorDetails.message = errorText;
            }
          }
        } catch {
          // Ignore error reading response body
        }

        throw new CorrelationError(
          `Graylog views search failed: ${response.statusText}`,
          "GRAYLOG_SEARCH_ERROR",
          errorDetails
        );
      }

      // Stream the response body directly without loading into memory
      // This is crucial for handling large datasets (millions of events)
      const body = response.body;
      if (!body) {
        throw new Error("Response body is null");
      }
      
      // Check if response is gzipped
      const contentEncoding = response.headers.get('content-encoding');
      const contentType = response.headers.get('content-type');
      const isGzipped = contentEncoding?.toLowerCase().includes('gzip') || false;
      
      console.log(`[Graylog] Response content-type: ${contentType}`);
      if (isGzipped) {
        console.log('[Graylog] Response is gzipped, will decompress during streaming');
      }
      
      // Check if this might be an error response instead of CSV
      if (contentType && !contentType.includes('csv')) {
        console.warn(`[Graylog] Warning: Expected CSV but got content-type: ${contentType}`);
      }
      
      // Process the response as a stream - pass the combined signal
      yield* this.streamParseCSVStream(body, combinedController.signal, isGzipped);
    } finally {
      // Clean up signal listeners
      cleanup();
    }
  }

  private async *streamParseCSVStream(
    body: NodeJS.ReadableStream,
    signal: AbortSignal,
    isGzipped: boolean = false
  ): AsyncGenerator<{ message: GraylogMessage; index: string }> {
    const Readable = require('stream').Readable;
    const zlib = require('zlib');
    const { Transform } = require('stream');
    
    // Performance and filtering configuration
    const BATCH_SIZE = 5000;  // Process CSV records in batches
    const YIELD_BATCH_SIZE = 1000;  // Yield results in smaller batches for better memory management
    const BLOOM_PRE_FILTER_BATCH = 100;  // Pre-filter raw CSV chunks before parsing
    
    // Get Bloom filter and correlation keys for optimization
    const bloomFilter = (this as any).bloomFilter;
    const correlationKeys = (this as any).correlationKeys as string[] | undefined;
    const hasBloomFilter = bloomFilter && typeof bloomFilter.mightContain === 'function' && correlationKeys && correlationKeys.length > 0;
    
    // Metrics tracking
    const metrics = {
      totalRecords: 0,
      bloomFilterRejects: 0,
      bloomFilterAccepts: 0,
      parseTime: 0,
      filterTime: 0,
      yieldedMessages: 0,
      startTime: Date.now()
    };
    
    console.log(`[CSV Streaming] Starting optimized CSV streaming with${hasBloomFilter ? '' : 'out'} Bloom filter pre-filtering`);
    if (hasBloomFilter) {
      console.log(`[CSV Streaming] Will pre-filter on correlation keys: ${correlationKeys.join(', ')}`);
    }
    
    // Convert web stream to Node.js stream if needed
    const nodeStream = body instanceof Readable ? body : Readable.from(body);
    
    // Smart decompression stream that detects if data is actually gzipped
    class SmartGunzip extends Transform {
      private gunzip: any = null;
      private isGzipped: boolean = false;
      private buffer: Buffer[] = [];
      private headerChecked: boolean = false;
      private totalBytes: number = 0;
      private isEnded: boolean = false;
      
      _transform(chunk: Buffer, encoding: string, callback: Function) {
        this.totalBytes += chunk.length;
        
        if (!this.headerChecked) {
          this.buffer.push(chunk);
          const combined = Buffer.concat(this.buffer);
          
          // Check for gzip magic bytes (1f 8b)
          if (combined.length >= 10) {
            this.headerChecked = true;
            this.isGzipped = combined[0] === 0x1f && combined[1] === 0x8b;
            
            if (this.isGzipped) {
              console.log('[Graylog] Data is gzipped (detected magic bytes), decompressing...');
              this.gunzip = zlib.createGunzip();
              this.gunzip.on('data', (data: Buffer) => this.push(data));
              this.gunzip.on('end', () => this.push(null));
              this.gunzip.on('error', (err: Error) => {
                console.error('[Graylog] Gunzip error:', err.message);
                // Push the raw data instead
                for (const buf of this.buffer) {
                  this.push(buf);
                }
                this.push(null);
              });
              
              // Write buffered data to gunzip
              for (const buf of this.buffer) {
                this.gunzip.write(buf);
              }
              this.buffer = [];
            } else {
              // Log first few bytes for debugging
              const preview = combined.slice(0, Math.min(200, combined.length)).toString('utf8');
              console.log('[Graylog] Data is not gzipped, first 200 bytes:', preview);
              console.log('[Graylog] Total bytes received so far:', this.totalBytes);
              
              // Check if this is an error response (starts with quotes and contains "Exception")
              if (preview.startsWith('"') && preview.includes('Exception')) {
                console.error('[Graylog] Received error response from server:', preview);
                
                // Check if it's the OpenSearch max result window error
                if (preview.includes('Result window is')) {
                  console.error('[Graylog] Hit OpenSearch max_result_window limit.');
                  console.error('[Graylog] To fetch more data, either:');
                  console.error('[Graylog]   1. Ask your admin to increase index.max_result_window in OpenSearch/Elasticsearch');
                  console.error('[Graylog]   2. Use smaller time windows to reduce the result set size');
                  console.error('[Graylog]   3. Add more specific filters to your query');
                }
                
                // Mark that we've ended to prevent flush from pushing more data
                this.isEnded = true;
                // Don't pass error responses to CSV parser
                this.push(null); // End the stream
                return callback();
              }
              
              // Not gzipped, pass through
              for (const buf of this.buffer) {
                this.push(buf);
              }
              this.buffer = [];
            }
          }
        } else {
          // Header already checked
          if (this.isGzipped && this.gunzip) {
            this.gunzip.write(chunk);
          } else {
            this.push(chunk);
          }
        }
        callback();
      }
      
      _flush(callback: Function) {
        console.log(`[SmartGunzip] Stream complete - Total bytes received: ${this.totalBytes}`);
        
        // Don't flush if we've already ended the stream due to an error
        if (this.isEnded) {
          callback();
          return;
        }
        
        if (this.gunzip) {
          this.gunzip.end();
        } else {
          // Flush any remaining buffered data
          for (const buf of this.buffer) {
            this.push(buf);
          }
        }
        callback();
      }
    }
    
    
    // Create processing pipeline with backpressure support
    let processingStream = nodeStream;
    
    // Add decompression if needed
    if (isGzipped) {
      const smartGunzip = new SmartGunzip();
      processingStream = processingStream.pipe(smartGunzip);
    }
    
    // Log if Bloom filter is available for filtering
    if (hasBloomFilter) {
      console.log(`[CSV Streaming] Bloom filter optimization enabled with ${bloomFilter.getStats().itemCount} items`);
      console.log(`[CSV Streaming] Will filter on correlation keys: ${correlationKeys.join(', ')}`);
    }
    
    // Use @fast-csv/parse for high-performance CSV parsing
    const fastCsv = require('@fast-csv/parse');
    
    
    const parser = fastCsv.parse({
      headers: true,  // Parse first row as headers
      skipEmptyLines: true,
      strictColumnHandling: false,  // Similar to relax_column_count
      discardUnmappedColumns: false,
      maxRows: 0,  // No limit
      delimiter: ',',
      quote: '"',
      escape: '"',
    });
    
    // Pipe directly to parser without intermediate transformation
    processingStream.pipe(parser);
    
    let headers: string[] | null = null;
    let recordBatch: any[] = [];
    let messageBatch: { message: GraylogMessage; index: string }[] = [];
    let errorDetected = false;
    let streamDestroyed = false;
    
    // Handle abort signal to properly destroy streams
    const abortHandler = () => {
      console.log('[CSV Streaming] Abort signal received, destroying streams...');
      streamDestroyed = true;
      
      // Destroy all streams in the pipeline
      if (nodeStream && typeof nodeStream.destroy === 'function') {
        nodeStream.destroy();
      }
      if (processingStream !== nodeStream && typeof processingStream.destroy === 'function') {
        processingStream.destroy();
      }
      if (parser && typeof parser.destroy === 'function') {
        parser.destroy();
      }
    };
    
    // Listen for abort signal
    signal.addEventListener('abort', abortHandler);
    
    // Listen for headers event from fast-csv
    parser.on('headers', (csvHeaders: string[]) => {
      headers = csvHeaders;
      console.log(`[CSV Streaming] Headers found: ${headers.length} fields`);
      console.log(`[CSV Streaming] All headers:`, headers);
      console.log(`[CSV Streaming] Key headers:`, headers.filter(h => 
        h === 'request_id' || h.endsWith('_id') || h.includes('trace')
      ).join(', '));
      
      // Debug: Check if any headers have special characters
      headers.forEach((h, idx) => {
        if (h.includes('"') || h.includes(',') || h.includes('\n') || h.includes('\r')) {
          console.warn(`[CSV Streaming] Header ${idx} contains special chars:`, h);
          console.warn(`[CSV Streaming] Header ${idx} hex:`, Buffer.from(h).toString('hex'));
        }
      });
    });
    
    // Collect all parsed records for batch processing
    const parsedRecords: any[] = [];
    let processingBatch = false;
    
    // Create a transform stream for batch processing with proper backpressure
    const self = this;
    const batchProcessor = new Transform({
      objectMode: true,
      highWaterMark: BATCH_SIZE * 2,
      async transform(record: any, _encoding: string, callback: Function) {
        recordCount++;
        
        // Debug first few records
        if (recordCount <= 3) {
          console.log(`[CSV Parser] Record ${recordCount}:`, Object.keys(record).slice(0, 5), '...');
          // Check for problematic values
          Object.entries(record).forEach(([key, value]) => {
            if (typeof value === 'string' && (value.includes('\n') || value.includes('\r') || value.includes('"'))) {
              console.warn(`[CSV Parser] Field '${key}' contains special chars in record ${recordCount}`);
            }
          });
        }
        
        if (signal.aborted) {
          console.log(`[CSV Streaming] Stream aborted after ${recordCount} records`);
          this.destroy();
          return callback();
        }
        
        // Count all records
        metrics.totalRecords++;
        recordBatch.push(record);
        
        // Process batch when it reaches BATCH_SIZE
        if (recordBatch.length >= BATCH_SIZE) {
          const currentBatch = recordBatch;
          recordBatch = [];
          
          const parseStart = Date.now();
          const batch = await self.processBatchOptimized(currentBatch, bloomFilter, correlationKeys, metrics);
          metrics.parseTime += Date.now() - parseStart;
          
          messageBatch.push(...batch);
          
          // Yield messages in smaller batches for memory management
          while (messageBatch.length >= YIELD_BATCH_SIZE) {
            const yieldBatch = messageBatch.splice(0, YIELD_BATCH_SIZE);
            for (const messageWrapper of yieldBatch) {
              parsedRecords.push(messageWrapper);
              metrics.yieldedMessages++;
            }
          }
          
          // Progress reporting
          if (metrics.totalRecords % 25000 === 0) {
            // Check abort signal during long operations
            if (signal.aborted) {
              console.log(`[CSV Streaming] Stream aborted after ${metrics.totalRecords} records during batch processing`);
              this.destroy();
              return callback();
            }
            
            const elapsed = Date.now() - metrics.startTime;
            const throughput = Math.round(metrics.totalRecords / (elapsed / 1000));
            const memUsage = process.memoryUsage();
            
            console.log(`[CSV Streaming] Processed ${metrics.totalRecords} records in ${elapsed}ms (${throughput} rec/s)`);
            console.log(`  - Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap used`);
            console.log(`  - Parse time: ${metrics.parseTime}ms`);
            console.log(`  - Filter time: ${metrics.filterTime}ms`);
            
            if (hasBloomFilter) {
              const filterEfficiency = metrics.bloomFilterRejects > 0 ? 
                Math.round(100 * metrics.bloomFilterRejects / (metrics.bloomFilterRejects + metrics.bloomFilterAccepts)) : 0;
              console.log(`  - Bloom filter: ${filterEfficiency}% rejection rate (${metrics.bloomFilterRejects} rejected, ${metrics.bloomFilterAccepts} accepted)`);
            }
          }
        }
        
        callback();
      },
      async flush(callback: Function) {
        // Process remaining records in final batch
        if (recordBatch.length > 0) {
          const parseStart = Date.now();
          const batch = await self.processBatchOptimized(recordBatch, bloomFilter, correlationKeys, metrics);
          metrics.parseTime += Date.now() - parseStart;
          
          messageBatch.push(...batch);
        }
        
        // Add any remaining messages
        for (const messageWrapper of messageBatch) {
          parsedRecords.push(messageWrapper);
          metrics.yieldedMessages++;
        }
        
        callback();
      }
    });
    
    // Process records using event-based approach
    let recordCount = 0;
    
    // Pipe through batch processor
    parser.pipe(batchProcessor);
    
    // Wait for batch processor to complete
    await new Promise<void>((resolve, reject) => {
      // Handle early termination from abort signal
      const checkAbort = setInterval(() => {
        if (streamDestroyed) {
          clearInterval(checkAbort);
          console.log('[CSV Streaming] Abort detected, resolving early');
          resolve();
        }
      }, 100);
      
      batchProcessor.on('finish', () => {
        clearInterval(checkAbort);
        // Final metrics report
        const totalTime = Date.now() - metrics.startTime;
        const avgThroughput = Math.round(metrics.totalRecords / (totalTime / 1000));
        const filterEfficiency = metrics.bloomFilterRejects > 0 ? 
          Math.round(100 * metrics.bloomFilterRejects / (metrics.bloomFilterRejects + metrics.bloomFilterAccepts)) : 0;
        
        console.log(`[CSV Streaming] Completed - Final metrics:`);
        console.log(`  - Total records: ${metrics.totalRecords}, Messages yielded: ${metrics.yieldedMessages}`);
        console.log(`  - Total time: ${totalTime}ms (avg ${avgThroughput} rec/s)`);
        console.log(`  - Parse time: ${metrics.parseTime}ms (${Math.round(100 * metrics.parseTime / totalTime)}%)`);
        console.log(`  - Filter time: ${metrics.filterTime}ms (${Math.round(100 * metrics.filterTime / totalTime)}%)`);
        
        if (hasBloomFilter) {
          console.log(`  - Bloom filter: ${metrics.bloomFilterRejects} rejected, ${metrics.bloomFilterAccepts} accepted (${filterEfficiency}% rejected)`);
          console.log(`  - Performance gain: ~${Math.round(100 * metrics.bloomFilterRejects / metrics.totalRecords)}% records avoided full parsing`);
        }
        
        if (errorDetected) {
          console.error(`[CSV Streaming] Completed with errors`);
        }
        
        resolve();
      });
      
      batchProcessor.on('error', (err: Error) => {
        clearInterval(checkAbort);
        console.error('[Batch Processor] Error:', err.message);
        errorDetected = true;
        reject(err);
      });
      
      parser.on('error', (err: Error) => {
        clearInterval(checkAbort);
        console.error('[CSV Parser] Error:', err.message);
        errorDetected = true;
        reject(err);
      });
    });
    
    // Clean up abort signal listener
    signal.removeEventListener('abort', abortHandler);
    
    // Check if we were aborted - but still yield already parsed records if we have them
    // This is important for semi-join optimization where we want partial results
    if (streamDestroyed && parsedRecords.length === 0) {
      console.log('[CSV Streaming] Stream was destroyed and no records were parsed, not yielding results');
      return;
    } else if (streamDestroyed && parsedRecords.length > 0) {
      console.log(`[CSV Streaming] Stream was destroyed but yielding ${parsedRecords.length} already parsed records`);
    }
    
    // Yield all collected records
    for (const record of parsedRecords) {
      yield record;
    }
  }

  /**
   * Optimized batch processing with optional Bloom filter and correlation key extraction
   */
  private async processBatchOptimized(
    recordBatch: any[],
    bloomFilter: any,
    correlationKeys: string[] | undefined,
    metrics?: any
  ): Promise<{ message: GraylogMessage; index: string }[]> {
    const results: { message: GraylogMessage; index: string }[] = [];
    const hasBloomFilter = bloomFilter && typeof bloomFilter.mightContain === 'function' && correlationKeys && correlationKeys.length > 0;
    
    if (recordBatch.length > 0) {
      console.log(`[CSV Processing] Processing batch of ${recordBatch.length} records. BloomFilter: ${!!bloomFilter}, CorrelationKeys: ${correlationKeys?.join(',') || 'none'}, HasBloomFilter: ${hasBloomFilter}`);
    }
    
    for (const record of recordBatch) {
      // Build message object from parsed record
      const fields: Record<string, any> = {};
      let requestId: string | undefined;
      
      // Extract fields efficiently
      for (const [key, value] of Object.entries(record)) {
        if (key === 'timestamp' || key === 'message' || key === 'source' || key === '_id') {
          continue; // These are handled separately
        }
        
        fields[key] = value;
        
        // Cache request_id for quick access
        if (key === 'request_id' && value) {
          requestId = value as string;
        }
      }
      
      // Apply Bloom filter at batch level
      if (hasBloomFilter) {
        const filterStart = Date.now();
        let shouldInclude = false;
        
        for (const key of correlationKeys!) {
          const value = fields[key] || (key === 'request_id' ? requestId : undefined);
          if (value && bloomFilter.mightContain(String(value))) {
            shouldInclude = true;
            break;
          }
        }
        
        if (metrics) {
          metrics.filterTime += Date.now() - filterStart;
        }
        
        if (!shouldInclude) {
          if (metrics) {
            metrics.bloomFilterRejects++;
          }
          continue; // Skip this record
        }
        
        if (metrics) {
          metrics.bloomFilterAccepts++;
        }
      }
      
      const message: GraylogMessage = {
        _id: record._id || `msg-${results.length}`,
        timestamp: record.timestamp || new Date().toISOString(),
        message: record.message || '',
        source: record.source || 'graylog',
        fields
      };
      
      // Add request_id to fields if present (NOT directly to message)
      // This ensures parseGraylogMessage can find it in the fields object
      if (requestId && !fields.request_id) {
        fields.request_id = requestId;
      }
      
      results.push({ 
        message, 
        index: this.options.streamId || "default" 
      });
    }
    
    return results;
  }

  private async searchViews(
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<GraylogSearchResponse> {
    const url = `${this.options.url}/api/views/search/messages`;

    // Calculate time window in seconds for relative timerange
    const range = (params.range as number) || 300; // Default 5 minutes

    // Convert query for Graylog v6 - handle special cases
    let query = (params.query as string) || "";

    // Graylog v6 doesn't allow '*' as first character in WildcardQuery
    // Use empty string for "all messages" queries
    if (query === "*" || query === "") {
      query = "";
    } else {
      // Ensure the query is properly formatted for Graylog v6
      query = this.sanitizeQueryForV6(query);
    }

    // Debug: Log the actual query being sent
    console.log(`[Graylog v6] Sending query: "${query}"`);
    
    const requestedLimit = (params.limit as number) || 100000000;
    console.log(`[Graylog v6] Requesting up to ${requestedLimit} events`);
    
    // Graylog v6 views API expects this exact structure with nested query_string
    // This is an export endpoint that can stream millions of events
    const requestBody: any = {
      query_string: {
        query_string: query,
      },
      timerange: {
        type: "relative",
        range: range // seconds
      },
      limit: requestedLimit,  // Use the full requested limit - this endpoint can handle it!
      // Note: Not specifying chunk_size to let Graylog use its default
      // chunk_size appears to be constrained by OpenSearch's max_result_window (10K)
    };
    
    // Handle field specification
    if (this.options.fields && this.options.fields.length > 0) {
      // Check if user specified "*" to get all fields
      if (this.options.fields.length === 1 && this.options.fields[0] === "*") {
        // Fetch all available fields from the system
        const allFields = await this.getAllFields(signal);
        if (allFields.length > 0) {
          requestBody.fields_in_order = allFields;
          console.log(`[Graylog v6] Requesting all ${allFields.length} available fields`);
        } else {
          // Fallback: don't specify fields and warn
          console.warn(
            "[Graylog v6] Could not fetch field list. Only basic fields will be returned."
          );
        }
      } else {
        // Use the specified fields
        requestBody.fields_in_order = this.options.fields;
      }
    } else {
      // WARNING: Without specifying fields, Graylog v6 only returns basic fields
      console.warn(
        "[Graylog v6] No fields specified - only basic fields (timestamp, source, message) will be returned. " +
        "To enable correlation, configure the 'fields' option with ['*'] to get all fields or specify required fields."
      );
    }

    // Note: Graylog v6 views API doesn't support offset-based pagination
    // It's an export endpoint that streams all results up to the limit instead

    // Add streams filter if configured
    // Check if stream filter was passed in params (from v6 path)
    if (params.filter && typeof params.filter === 'string' && params.filter.startsWith('streams:')) {
      const streamId = params.filter.substring('streams:'.length);
      if (/^[a-f0-9]{24}$/i.test(streamId)) {
        requestBody.streams = [streamId];
        console.log(`[Graylog v6] Filtering to stream ID from params: ${streamId}`);
      }
    } else {
      // Fallback to checking for stream ID set on instance
      const effectiveStreamId = await this.getEffectiveStreamId();
      if (effectiveStreamId) {
        // Validate that streamId looks like a MongoDB ObjectId (24 hex characters)
        if (/^[a-f0-9]{24}$/i.test(effectiveStreamId)) {
          requestBody.streams = [effectiveStreamId];
          console.log(`[Graylog v6] Filtering to stream ID: ${effectiveStreamId}`);
        } else {
          // Don't log the actual stream ID for security reasons (CodeQL js/clear-text-logging)
          console.warn(
            `Warning: Invalid streamId format - must be 24 hex characters. Ignoring stream filter.`
          );
        }
      }
    }

    // Debug log the request
    console.log(`[Graylog v6] Request body:`, JSON.stringify(requestBody, null, 2));
    
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "text/csv", // v6 API returns CSV by default
        "X-Requested-By": "log-correlator",
      },
      body: JSON.stringify(requestBody),
      signal,
      agent: this.proxyAgent as any,
    };

    const response = await fetch(url, fetchOptions);
    
    console.log(`[Graylog v6] Response status: ${response.status}`);
    console.log(`[Graylog v6] Response headers:`, Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      // Try to get error details from response body
      let errorDetails: any = { status: response.status };
      try {
        const errorText = await response.text();
        if (errorText) {
          try {
            errorDetails = JSON.parse(errorText);
          } catch {
            errorDetails.message = errorText;
          }
        }
      } catch {
        // Ignore error reading response body
      }

      throw new CorrelationError(
        `Graylog views search failed: ${response.statusText}`,
        "GRAYLOG_SEARCH_ERROR",
        errorDetails
      );
    }

    // Parse CSV response (v6 API returns CSV by default)
    const csvText = await response.text();
    return this.parseCSVResponse(csvText);
  }

  private parseCSVResponse(csv: string): GraylogSearchResponse {
    const lines = csv.split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      return {
        messages: [],
        total_results: 0,
        from: new Date().toISOString(),
        to: new Date().toISOString(),
      };
    }

    // Parse CSV header
    const headers = this.parseCSVLine(lines[0]);
    console.log(`[CSV Debug] Headers found: ${headers.join(', ')}`);
    console.log(`[CSV Debug] Total lines: ${lines.length}`);
    
    // Check if request_id is in headers
    const hasRequestId = headers.includes('request_id');
    console.log(`[CSV Debug] Has request_id field: ${hasRequestId}`);
    const messages: Array<{ message: GraylogMessage; index: string }> = [];

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (i === 1) {
        console.log(`[CSV Debug] First row values: ${values.slice(0, 10).join(' | ')}`);
        console.log(`[CSV Debug] Values count: ${values.length}, Headers count: ${headers.length}`);
      }
      if (values.length !== headers.length) continue;

      const fields: Record<string, unknown> = {};
      let timestamp = "";
      let message = "";
      let source = "";
      let id = "";

      for (let j = 0; j < headers.length; j++) {
        const header = headers[j];
        const headerLower = header.toLowerCase();
        const value = values[j];

        if (headerLower === "timestamp") {
          timestamp = value;
        } else if (headerLower === "message") {
          message = value;
        } else if (headerLower === "source") {
          source = value;
        } else if (headerLower === "_id" || headerLower === "id") {
          id = value;
        } else {
          // Keep original field name case for proper field matching
          fields[header] = value;
          if (i === 1 && j < 5) {
            console.log(`[CSV Debug] Field "${header}" = "${value}"`);
          }
          // Special debug for request_id
          if (header === "request_id" && i === 1) {
            console.log(`[CSV Debug] *** request_id value in first row: "${value}"`);
          }
        }
      }

      messages.push({
        message: {
          _id: id || `msg_${i}`,
          timestamp,
          message,
          source,
          fields,
        },
        index: "graylog",
      });
    }

    return {
      messages,
      total_results: messages.length,
      from: messages[0]?.message.timestamp || new Date().toISOString(),
      to:
        messages[messages.length - 1]?.message.timestamp ||
        new Date().toISOString(),
    };
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        // Field separator
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    // Add last field
    if (current || line.endsWith(",")) {
      result.push(current);
    }

    return result;
  }

  private parseGraylogMessage(message: GraylogMessage): LogEvent {
    // Extract labels from fields for correlation and filtering
    const labels: Record<string, string> = {};
    const joinKeys: Record<string, string> = {};
    
    // Debug logging for first few messages
    if (!this.debugCounter) this.debugCounter = 0;
    this.debugCounter++;
    const shouldDebug = this.debugCounter <= 3;

    // Universal field extraction: Handle two possible Graylog response structures
    // Structure 1 (Standard): Custom fields in message.fields object - most common format
    // Structure 2 (Direct): Custom fields directly on message object - some Graylog configurations
    // This ensures compatibility across different Graylog versions and configurations
    const fieldsSource = message.fields || message;
    
    // System fields that should not be extracted as labels
    // These are either handled separately or are Graylog-internal metadata
    const skipFields = new Set([
      '_id',              // Message identifier (handled separately)
      'message',          // Log message content (handled separately) 
      'timestamp',        // Message timestamp (handled separately)
      'source',           // Message source (handled separately)
      'fields',           // Fields container (handled separately)
      'gl2_message_id',   // Graylog 2.x message ID (system field)
      'streams',          // Stream assignments (system field)
      'decoration_stats'  // Message decoration metadata (system field)
    ]);
    
    // Extract all custom fields as labels for correlation
    for (const [key, value] of Object.entries(fieldsSource)) {
      // Skip system fields that are handled elsewhere or are internal to Graylog
      if (skipFields.has(key)) continue;
      
      // Only extract primitive values that can be reliably converted to strings
      // Objects and arrays are skipped as they cannot be used for correlation matching
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        const stringValue = String(value);
        
        // Skip empty strings - they can't be used for correlation
        if (stringValue === "") continue;
        
        // Convert all values to strings for consistent correlation matching
        labels[key] = stringValue;

        // Automatically detect fields that are likely to be correlation/join keys
        // These patterns cover common logging practices for request tracing
        if (
          key.endsWith("_id") ||           // request_id, trace_id, session_id, user_id, etc.
          key.includes("correlation") ||   // correlation_id, correlation_token, etc.
          key.includes("trace") ||         // trace_id, trace_span, trace_token, etc.
          key.includes("request_id")       // Explicit request_id pattern matching
        ) {
          joinKeys[key] = stringValue;
        }
      }
      // Note: null, undefined, objects, and arrays are silently skipped
      // This prevents type errors and ensures only correlatable values are extracted
    }

    // Additional join key extraction: Parse message content for correlation IDs
    // This catches correlation IDs that might be embedded in log messages as text
    // rather than structured as separate fields (fallback extraction)
    if (message.message) {
      const extractedKeys = this.extractJoinKeys(message.message);
      Object.assign(joinKeys, extractedKeys);
    }
    
    if (shouldDebug) {
      console.log(`[parseGraylogMessage] Message ${this.debugCounter}:`);
      console.log(`  - Labels extracted: ${Object.keys(labels).length} (includes: ${Object.keys(labels).slice(0, 5).join(', ')})`);
      // Only show request_id specifically since that's what matters for correlation
      if (labels.request_id) {
        console.log(`  - request_id found: "${labels.request_id}"`);
      } else {
        console.log(`  - request_id: not found in message fields`);
      }
    }

    return {
      timestamp: message.timestamp || new Date().toISOString(),
      source: (this as any).sourceName || "graylog",  // Use configured source name if available
      stream: message.source || "unknown",  // Will be overridden by streamIdentifier if needed
      message: message.message || "",
      labels,        // All extracted custom fields for filtering/correlation
      joinKeys,      // Automatically detected correlation keys for join operations
    };
  }

  /**
   * Extract correlation IDs from log message text content
   * This is a fallback method for cases where correlation IDs are embedded
   * in the message text rather than provided as structured fields
   * 
   * @param message - The log message text content
   * @returns Record of extracted join keys with normalized names
   */
  private extractJoinKeys(message: string): Record<string, string> {
    const keys: Record<string, string> = {};

    // Regular expression patterns for common correlation ID formats in log messages
    // These patterns match various formats: request_id=abc123, trace-id: xyz789, etc.
    const patterns = [
      /request[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,    // request_id, request-id, requestId
      /trace[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,      // trace_id, trace-id, traceId  
      /session[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i,    // session_id, session-id, sessionId
      /correlation[_-]?id[=:\s]+["']?([a-zA-Z0-9-]+)/i, // correlation_id, correlation-id
    ];

    // Apply each pattern to extract correlation IDs from message text
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        // Normalize the key name to a consistent format (e.g., "requestid" -> "request_id")
        const keyName = pattern.source
          .split("[")[0]           // Get the key part before the first bracket
          .toLowerCase()           // Normalize to lowercase
          .replace(/[^a-z]/g, ""); // Remove non-alphabetic characters
        keys[keyName + "_id"] = match[1]; // Store normalized key with extracted value
      }
    }

    return keys;
  }

  private sanitizeQueryForV6(query: string): string {
    // Graylog v6 has stricter query parsing rules
    // Handle common patterns that cause issues

    // Remove leading/trailing whitespace
    query = query.trim();

    // If query is just a wildcard, return empty (search all)
    if (query === "*") {
      return "";
    }

    // If query starts with standalone wildcard, remove it (not allowed in v6)
    if (query.startsWith("* ")) {
      query = query.substring(2).trim();
    }

    // Handle empty field queries (e.g., "field:" without value)
    // These cause parse errors in v6
    // Use string manipulation instead of regex to avoid ReDoS
    // Process patterns like "field: AND", "field: OR", or "field:" at end

    // Helper functions for character classification
    const isWordChar = (char: string): boolean => {
      return (
        (char >= "a" && char <= "z") ||
        (char >= "A" && char <= "Z") ||
        (char >= "0" && char <= "9") ||
        char === "_"
      );
    };

    const isWhitespace = (char: string): boolean => {
      return char === " " || char === "\t" || char === "\n" || char === "\r";
    };

    // Helper function to process the query without regex
    const processEmptyFields = (str: string): string => {
      let result = "";
      let i = 0;

      while (i < str.length) {
        // Look for word characters followed by colon
        if (i > 0 && str[i] === ":" && isWordChar(str[i - 1])) {
          // Found a potential field, check what follows
          let j = i + 1;

          // Skip whitespace after colon
          while (j < str.length && isWhitespace(str[j])) {
            j++;
          }

          // Check if we hit AND, OR, or end of string
          if (
            j >= str.length ||
            str.substring(j, j + 3) === "AND" ||
            str.substring(j, j + 2) === "OR"
          ) {
            // Insert * after the colon
            result += ":*";
            i++;
          } else {
            result += str[i];
            i++;
          }
        } else {
          result += str[i];
          i++;
        }
      }

      return result;
    };

    query = processEmptyFields(query);

    // Handle quoted empty values - remove them entirely
    // Use string manipulation to avoid ReDoS vulnerability
    const removeEmptyQuotes = (str: string): string => {
      let result = "";
      let i = 0;

      while (i < str.length) {
        // Check for pattern like word:"" or word:''
        if (
          i > 0 &&
          str[i] === ":" &&
          i + 2 < str.length &&
          ((str[i + 1] === '"' && str[i + 2] === '"') ||
            (str[i + 1] === "'" && str[i + 2] === "'"))
        ) {
          // Check if preceded by word characters
          let j = i - 1;
          while (j >= 0 && isWordChar(str[j])) {
            j--;
          }
          if (j < i - 1) {
            // We found word:"" or word:'', skip the :""/:''
            i += 3;
            continue;
          }
        }
        result += str[i];
        i++;
      }
      return result;
    };

    query = removeEmptyQuotes(query);

    // Handle invalid patterns like ":value" (colon without field name)
    // Remove colons at start or after whitespace that are followed by word chars
    const removeInvalidColons = (str: string): string => {
      let result = "";
      let i = 0;

      while (i < str.length) {
        if (str[i] === ":" && (i === 0 || isWhitespace(str[i - 1]))) {
          // Skip this colon and any following word characters
          i++;
          while (i < str.length && isWordChar(str[i])) {
            i++;
          }
        } else {
          result += str[i];
          i++;
        }
      }
      return result;
    };

    query = removeInvalidColons(query);

    // Clean up multiple spaces and trim without regex
    const cleanupSpaces = (str: string): string => {
      let result = "";
      let lastWasSpace = false;

      for (let i = 0; i < str.length; i++) {
        if (isWhitespace(str[i])) {
          if (!lastWasSpace) {
            result += " ";
            lastWasSpace = true;
          }
        } else {
          result += str[i];
          lastWasSpace = false;
        }
      }

      return result.trim();
    };

    query = cleanupSpaces(query);

    // If query becomes empty after sanitization, return empty string
    if (!query || query === "AND" || query === "OR") {
      return "";
    }

    return query;
  }

  private convertToGraylogQuery(query: string): string {
    // Convert from simplified syntax to Graylog query
    // Example: service:backend -> service:backend
    // Example: service="backend" -> service:backend

    // Parse without regex to avoid ReDoS vulnerabilities
    let result = "";
    let i = 0;

    while (i < query.length) {
      // Look for field="value" or field='value' patterns
      const fieldStart = i;
      // Check for word characters without regex
      while (
        i < query.length &&
        ((query[i] >= "a" && query[i] <= "z") ||
          (query[i] >= "A" && query[i] <= "Z") ||
          (query[i] >= "0" && query[i] <= "9") ||
          query[i] === "_")
      ) {
        i++;
      }

      if (i > fieldStart && i < query.length && query[i] === "=") {
        const field = query.substring(fieldStart, i);
        i++; // skip '='

        if (i < query.length && (query[i] === '"' || query[i] === "'")) {
          const quote = query[i];
          i++; // skip opening quote
          const valueStart = i;

          // Find closing quote
          while (i < query.length && query[i] !== quote) {
            i++;
          }

          if (i < query.length) {
            const value = query.substring(valueStart, i);
            result += field + ":" + value;
            i++; // skip closing quote
          } else {
            // No closing quote, treat as literal
            result += query.substring(fieldStart);
            break;
          }
        } else {
          // No quotes after =, revert to original
          result += query.substring(fieldStart, i);
        }
      } else {
        // Not a field=value pattern, copy as-is
        if (fieldStart < i) {
          result += query.substring(fieldStart, i);
        }
        if (i < query.length) {
          result += query[i];
          i++;
        }
      }
    }

    // Handle AND/OR operators
    const words: string[] = [];
    let currentWord = "";

    for (let j = 0; j < result.length; j++) {
      if (
        result[j] === " " ||
        result[j] === "\t" ||
        result[j] === "\n" ||
        result[j] === "\r"
      ) {
        if (currentWord) {
          const upperWord = currentWord.toUpperCase();
          words.push(
            upperWord === "AND" || upperWord === "OR" ? upperWord : currentWord
          );
          currentWord = "";
        }
      } else {
        currentWord += result[j];
      }
    }
    if (currentWord) {
      const upperWord = currentWord.toUpperCase();
      words.push(
        upperWord === "AND" || upperWord === "OR" ? upperWord : currentWord
      );
    }

    result = words.join(" ");

    return result;
  }

  private parseTimeRange(timeRange: string): number {
    const match = timeRange.match(/^(\d+)([smhd])$/);
    if (!match) {
      // Default to 5 minutes
      return 5 * 60 * 1000;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      default:
        return 5 * 60 * 1000;
    }
  }

  validateQuery(query: string): boolean {
    // Maintain backward compatibility - reject empty queries
    if (!query || query.length === 0) {
      return false;
    }
    
    // Limit query length to prevent DoS
    if (query.length > 10000) {
      return false;
    }
    
    // Use the parser for validation
    const result = this.parser.validate(query);

    if (!result.valid) {
      // Log errors for debugging
      if (result.errors) {
        result.errors.forEach((error) => {
          console.error(`Query validation error: ${error.message}`);
          if (error.suggestion) {
            console.error(`  Suggestion: ${error.suggestion}`);
          }
        });
      }
    }

    // Log warnings but don't fail validation
    if (result.warnings) {
      result.warnings.forEach((warning) => {
        console.warn(`Query validation warning: ${warning.message}`);
        if (warning.suggestion) {
          console.warn(`  Suggestion: ${warning.suggestion}`);
        }
      });
    }

    return result.valid;
  }

  async getAvailableStreams(): Promise<string[]> {
    const url = `${this.options.url}/api/streams`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "X-Requested-By": "log-correlator",
        },
        agent: this.proxyAgent as any,
      });

      if (!response.ok) {
        throw new CorrelationError(
          "Failed to fetch available streams",
          "GRAYLOG_STREAMS_ERROR"
        );
      }

      const data = await response.json();
      return data.streams?.map((s: { title: string }) => s.title) || [];
    } catch (error) {
      console.error("Failed to get available streams:", error);
      return [];
    }
  }

  async destroy(): Promise<void> {
    // Cancel all active polling streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();

    // Wait for stream resolution to complete if in progress
    // This prevents the "Cannot log after tests are done" error
    if (this.streamResolutionPromise) {
      try {
        await this.streamResolutionPromise;
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.streamResolutionPromise = undefined;
    }
  }
}
