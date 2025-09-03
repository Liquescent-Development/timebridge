import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Connection } from 'duckdb';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface FIFOIngestionOptions {
  tableName: string;
  streamId: string;
  headers?: string[];
  delimiter?: string;
  nullString?: string;
  parallel?: boolean;
  columnMapping?: {
    timestamp?: string;
    source?: string;
    message?: string;
    request_id?: string;
    [key: string]: string | undefined;
  };
}

export interface FIFOMetadata {
  fifoPath: string;
  streamId: string;
  headers?: string[];
  writer?: NodeJS.WritableStream;
  readerPromise?: Promise<number>;
}

/**
 * Handles streaming CSV ingestion into DuckDB using named pipes (FIFOs)
 * This allows zero-copy streaming from Graylog API directly to DuckDB
 */
export class DuckDBFIFOIngestion extends EventEmitter {
  private conn: Connection;
  private fifoDir: string;
  private activeFifos = new Map<string, FIFOMetadata>();

  constructor(connection: Connection, fifoDir?: string) {
    super();
    this.conn = connection;
    this.fifoDir = fifoDir || path.join(os.tmpdir(), 'timebridge-fifos');
    
    // Ensure FIFO directory exists
    if (!fs.existsSync(this.fifoDir)) {
      fs.mkdirSync(this.fifoDir, { recursive: true });
    }
  }

  /**
   * Create a named pipe (FIFO) for streaming
   */
  async createFIFO(streamId: string): Promise<string> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const fifoName = `stream_${streamId}_${timestamp}_${random}.fifo`;
    const fifoPath = path.join(this.fifoDir, fifoName);
    
    try {
      // Create the named pipe using mkfifo command
      await execAsync(`mkfifo "${fifoPath}"`);
      console.log(`[DuckDB FIFO] Created named pipe: ${fifoPath}`);
      return fifoPath;
    } catch (error) {
      console.error(`[DuckDB FIFO] Failed to create named pipe:`, error);
      throw error;
    }
  }

  /**
   * Start streaming CSV data into DuckDB from a FIFO
   * This returns immediately and runs the COPY command in the background
   */
  async startFIFOIngestion(options: FIFOIngestionOptions): Promise<FIFOMetadata> {
    const { tableName, streamId, headers, delimiter = ',', nullString = '', parallel = true } = options;
    
    // Create the FIFO
    const fifoPath = await this.createFIFO(streamId);
    
    // Create metadata object
    const metadata: FIFOMetadata = {
      fifoPath,
      streamId,
      headers
    };
    
    // Store metadata
    this.activeFifos.set(streamId, metadata);
    
    console.log(`[DuckDB FIFO] Created metadata for stream ${streamId}:`, {
      fifoPath,
      headers,
      delimiter,
      nullString
    });
    
    // First, let's try to see what columns DuckDB actually detects
    const debugSQL = `
      SELECT * FROM read_csv('${fifoPath}', 
        header = true,
        delim = '${delimiter}',
        nullstr = '${nullString}',
        parallel = ${parallel},
        auto_detect = true
      ) LIMIT 0;
    `;
    
    // Use a simpler approach first - let's just try to insert basic fields
    // We'll handle the JSON labels after we confirm data is flowing
    // Now that we're properly sending headers first, use proper column names
    // Use INSERT with read_csv_auto which handles CSV parsing automatically
    // Including multiline fields properly quoted
    const copySQL = `
      INSERT INTO ${tableName} (timestamp, source, stream, message, request_id)
      SELECT 
        CURRENT_TIMESTAMP as timestamp,
        'graylog' as source,
        '${streamId}' as stream,
        COALESCE(csv.message, '') as message,
        csv.request_id as request_id
      FROM read_csv_auto('${fifoPath}', 
        header = true,
        delim = '${delimiter}',
        quote = '"',
        escape = '"',
        ignore_errors = true,
        null_padding = true,
        all_varchar = true
      ) AS csv;
    `;
    
    console.log(`[DuckDB FIFO] Starting background COPY for stream ${streamId}`);
    console.log(`[DuckDB FIFO] SQL: ${copySQL}`);
    
    // Execute COPY in background (it will wait for data)
    metadata.readerPromise = new Promise<number>((resolve, reject) => {
      const startTime = Date.now();
      
      // Don't run debug queries that might block - they could interfere with the main COPY
      // The main COPY operation will handle reading the data
      
      this.conn.run(copySQL, (err) => {
        if (err) {
          console.error(`[DuckDB FIFO] COPY failed for stream ${streamId}:`, err);
          reject(err);
        } else {
          const elapsed = Date.now() - startTime;
          console.log(`[DuckDB FIFO] COPY completed for stream ${streamId} in ${elapsed}ms`);
          
          // Get row count for this stream
          this.getStreamRowCount(tableName, streamId).then(resolve).catch(reject);
        }
      });
    });
    
    // Create a write stream for the FIFO
    // Add a small delay to ensure DuckDB is ready and waiting
    await new Promise(resolve => setTimeout(resolve, 100));
    metadata.writer = fs.createWriteStream(fifoPath, { flags: 'w', encoding: 'utf8' });
    
    let bytesWritten = 0;
    let linesWritten = 0;
    
    // Track data being written
    const originalWrite = metadata.writer.write.bind(metadata.writer);
    metadata.writer.write = function(chunk: any, ...args: any[]): boolean {
      const chunkStr = chunk.toString();
      bytesWritten += chunkStr.length;
      linesWritten += (chunkStr.match(/\n/g) || []).length;
      
      if (bytesWritten === 0) {
        // Log the first chunk to see what we're actually getting
        console.log(`[DuckDB FIFO] First chunk for ${streamId} (${chunkStr.length} chars):`, chunkStr.substring(0, 500));
        
        const lines = chunkStr.split('\n');
        console.log(`[DuckDB FIFO] First 3 lines:`);
        lines.slice(0, 3).forEach((line: string, i: number) => {
          console.log(`  Line ${i}: ${line.substring(0, 200)}`);
        });
      }
      
      if (linesWritten <= 5) {
        console.log(`[DuckDB FIFO] Writing chunk to ${streamId} (${chunkStr.length} bytes):`, 
          chunkStr.substring(0, 200));
      } else if (linesWritten % 1000 === 0) {
        console.log(`[DuckDB FIFO] Progress for ${streamId}: ${linesWritten} lines, ${bytesWritten} bytes`);
      }
      
      return originalWrite(chunk, ...args);
    };
    
    metadata.writer.on('error', (error) => {
      console.error(`[DuckDB FIFO] Write error for stream ${streamId}:`, error);
    });
    
    metadata.writer.on('finish', () => {
      console.log(`[DuckDB FIFO] Write stream finished for ${streamId}. Total: ${bytesWritten} bytes, ${linesWritten} lines`);
    });
    
    return metadata;
  }

  /**
   * Get the write stream for a specific stream ID
   */
  getWriteStream(streamId: string): NodeJS.WritableStream | undefined {
    return this.activeFifos.get(streamId)?.writer;
  }

  /**
   * Wait for ingestion to complete and get row count
   */
  async waitForIngestion(streamId: string): Promise<number> {
    const metadata = this.activeFifos.get(streamId);
    if (!metadata || !metadata.readerPromise) {
      throw new Error(`No active ingestion for stream ${streamId}`);
    }
    
    try {
      const rowCount = await metadata.readerPromise;
      console.log(`[DuckDB FIFO] Stream ${streamId} ingested ${rowCount} rows`);
      
      this.emit('ingestion-complete', {
        streamId,
        rowsIngested: rowCount
      });
      
      return rowCount;
    } catch (error) {
      console.error(`[DuckDB FIFO] Ingestion failed for stream ${streamId}:`, error);
      throw error;
    }
  }

  /**
   * Clean up FIFOs after ingestion
   */
  async cleanup(streamId?: string): Promise<void> {
    const toClean = streamId 
      ? [this.activeFifos.get(streamId)].filter(Boolean)
      : Array.from(this.activeFifos.values());
    
    for (const metadata of toClean) {
      if (!metadata) continue;
      
      try {
        // Close the write stream if still open
        if (metadata.writer && !(metadata.writer as any).destroyed) {
          metadata.writer.end();
        }
        
        // Wait for reader to complete (with timeout)
        if (metadata.readerPromise) {
          await Promise.race([
            metadata.readerPromise,
            new Promise(resolve => setTimeout(resolve, 5000))
          ]).catch(() => {}); // Ignore errors during cleanup
        }
        
        // Remove the FIFO file
        if (fs.existsSync(metadata.fifoPath)) {
          fs.unlinkSync(metadata.fifoPath);
          console.log(`[DuckDB FIFO] Cleaned up FIFO for stream ${metadata.streamId}`);
        }
      } catch (error) {
        console.warn(`[DuckDB FIFO] Failed to clean up ${metadata.fifoPath}:`, error);
      }
      
      // Remove from active FIFOs
      this.activeFifos.delete(metadata.streamId);
    }
  }

  /**
   * Get row count for a specific stream
   */
  private async getStreamRowCount(tableName: string, streamId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // Assuming the table has a 'stream' column that contains the stream ID
      const sql = `SELECT COUNT(*) as count FROM ${tableName} WHERE stream = '${streamId}'`;
      
      this.conn.all(sql, (err, result) => {
        if (err) {
          // If stream column doesn't exist, get total count
          this.conn.all(`SELECT COUNT(*) as count FROM ${tableName}`, (err2, result2) => {
            if (err2) reject(err2);
            else resolve(result2[0]?.count || 0);
          });
        } else {
          resolve(result[0]?.count || 0);
        }
      });
    });
  }

  /**
   * Create a streaming pipeline from source to DuckDB
   * This sets up the FIFO and returns a function to pipe data through it
   */
  async createStreamingPipeline(
    source: NodeJS.ReadableStream,
    options: FIFOIngestionOptions
  ): Promise<{ metadata: FIFOMetadata; rowCount: Promise<number> }> {
    const metadata = await this.startFIFOIngestion(options);
    
    // Pipe the source directly to the FIFO write stream
    source.pipe(metadata.writer!);
    
    // Return metadata and a promise for the final row count
    return {
      metadata,
      rowCount: this.waitForIngestion(options.streamId)
    };
  }
}