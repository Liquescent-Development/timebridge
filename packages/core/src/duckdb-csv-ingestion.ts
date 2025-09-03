import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Connection } from 'duckdb';
import { EventEmitter } from 'events';

export interface CSVIngestionOptions {
  tableName: string;
  streamId: string;
  csvPath: string;
  headers?: string[];
  delimiter?: string;
  nullString?: string;
  parallel?: boolean;
}

export interface CSVStreamMetadata {
  csvPath: string;
  headers: string[];
  rowCount?: number;
  streamId: string;
}

/**
 * Handles direct CSV ingestion into DuckDB
 * This bypasses Node.js memory by letting DuckDB read CSV files directly
 */
export class DuckDBCSVIngestion extends EventEmitter {
  private conn: Connection;
  private tempDir: string;
  private tempFiles = new Map<string, CSVStreamMetadata>();

  constructor(connection: Connection, tempDir?: string) {
    super();
    this.conn = connection;
    this.tempDir = tempDir || path.join(os.tmpdir(), 'timebridge-csv');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Create a temp file for CSV streaming
   */
  createTempFile(streamId: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const filename = `stream_${streamId}_${timestamp}_${random}.csv`;
    const filepath = path.join(this.tempDir, filename);
    
    return filepath;
  }

  /**
   * Register a CSV file for later ingestion
   */
  registerCSVStream(metadata: CSVStreamMetadata): void {
    this.tempFiles.set(metadata.streamId, metadata);
    console.log(`[DuckDB CSV] Registered CSV file for stream ${metadata.streamId}: ${metadata.csvPath}`);
  }

  /**
   * Ingest a CSV file directly into DuckDB using COPY or read_csv
   */
  async ingestCSVFile(options: CSVIngestionOptions): Promise<number> {
    const startTime = Date.now();
    const { tableName, csvPath, headers, delimiter = ',', nullString = '', parallel = true } = options;

    try {
      // First, check if file exists and get size
      const stats = fs.statSync(csvPath);
      const fileSizeMB = stats.size / (1024 * 1024);
      console.log(`[DuckDB CSV] Ingesting ${fileSizeMB.toFixed(2)}MB CSV file from ${csvPath}`);

      // Get the current row count before ingestion
      const countBefore = await this.getRowCount(tableName);

      // Build the COPY command with options
      // DuckDB will automatically detect headers if present
      const copyOptions = [
        'AUTO_DETECT true',
        `DELIMITER '${delimiter}'`,
        `NULL '${nullString}'`,
        'HEADER true'
      ];

      if (parallel) {
        copyOptions.push('PARALLEL true');
      }

      // Use COPY for direct file ingestion (most efficient)
      const copySQL = `
        COPY ${tableName} FROM '${csvPath}' (
          ${copyOptions.join(',\n          ')}
        );
      `;

      console.log(`[DuckDB CSV] Executing: ${copySQL}`);
      
      // Execute the COPY command
      await new Promise<void>((resolve, reject) => {
        this.conn.run(copySQL, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Get row count after ingestion
      const countAfter = await this.getRowCount(tableName);
      const rowsIngested = countAfter - countBefore;
      
      const elapsed = Date.now() - startTime;
      const rowsPerSec = Math.round((rowsIngested / elapsed) * 1000);
      
      console.log(`[DuckDB CSV] Ingested ${rowsIngested} rows in ${elapsed}ms (${rowsPerSec} rows/sec)`);
      console.log(`[DuckDB CSV] Memory usage: ${process.memoryUsage().heapUsed / 1024 / 1024}MB heap`);
      
      this.emit('ingestion-complete', {
        streamId: options.streamId,
        rowsIngested,
        elapsed,
        fileSizeMB
      });

      return rowsIngested;

    } catch (error) {
      console.error(`[DuckDB CSV] Failed to ingest CSV file ${csvPath}:`, error);
      throw error;
    }
  }

  /**
   * Alternative: Use read_csv function for more flexibility
   * This allows querying the CSV directly without copying to a table first
   */
  async ingestWithReadCSV(options: CSVIngestionOptions): Promise<number> {
    const { tableName, csvPath, streamId } = options;
    const startTime = Date.now();

    try {
      // Insert directly from read_csv function
      // This is more flexible as we can transform data during insertion
      const insertSQL = `
        INSERT INTO ${tableName}
        SELECT 
          timestamp,
          source,
          '${streamId}' as stream,
          message,
          request_id,
          application,
          tier,
          spc_tier,
          http_status,
          http_status_class,
          account_id,
          request_account_id,
          request_principal,
          user_agent,
          action,
          hostname
        FROM read_csv('${csvPath}', 
          AUTO_DETECT = true,
          HEADER = true,
          PARALLEL = true
        );
      `;

      console.log(`[DuckDB CSV] Using read_csv to ingest from ${csvPath}`);

      const result = await new Promise<any>((resolve, reject) => {
        this.conn.all(insertSQL, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      const elapsed = Date.now() - startTime;
      console.log(`[DuckDB CSV] Ingested via read_csv in ${elapsed}ms`);

      return result.length || 0;

    } catch (error) {
      console.error(`[DuckDB CSV] Failed to ingest with read_csv:`, error);
      throw error;
    }
  }

  /**
   * Ingest multiple CSV files for different streams
   */
  async ingestAllStreams(tableName: string): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    for (const [streamId, metadata] of this.tempFiles) {
      try {
        const rowCount = await this.ingestCSVFile({
          tableName,
          streamId,
          csvPath: metadata.csvPath,
          headers: metadata.headers
        });
        
        results.set(streamId, rowCount);
      } catch (error) {
        console.error(`[DuckDB CSV] Failed to ingest stream ${streamId}:`, error);
        results.set(streamId, 0);
      }
    }

    return results;
  }

  /**
   * Clean up temp files after ingestion
   */
  async cleanup(): Promise<void> {
    for (const [streamId, metadata] of this.tempFiles) {
      try {
        if (fs.existsSync(metadata.csvPath)) {
          fs.unlinkSync(metadata.csvPath);
          console.log(`[DuckDB CSV] Cleaned up temp file for stream ${streamId}`);
        }
      } catch (error) {
        console.warn(`[DuckDB CSV] Failed to clean up ${metadata.csvPath}:`, error);
      }
    }
    
    this.tempFiles.clear();
  }

  /**
   * Get current row count for a table
   */
  private async getRowCount(tableName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.conn.all(`SELECT COUNT(*) as count FROM ${tableName}`, (err, result) => {
        if (err) reject(err);
        else resolve(result[0]?.count || 0);
      });
    });
  }

  /**
   * Create a write stream for streaming CSV data
   */
  createCSVWriteStream(streamId: string): { stream: fs.WriteStream; path: string } {
    const csvPath = this.createTempFile(streamId);
    const stream = fs.createWriteStream(csvPath, { flags: 'w', encoding: 'utf8' });
    
    // Register the stream
    this.registerCSVStream({
      csvPath,
      streamId,
      headers: [] // Will be updated when headers are written
    });

    return { stream, path: csvPath };
  }
}