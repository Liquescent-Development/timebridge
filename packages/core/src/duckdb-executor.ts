import * as duckdb from 'duckdb';
import { LogEvent, CorrelatedEvent, CorrelationError } from './types';
import { EventEmitter } from 'eventemitter3';
import * as path from 'path';
import * as fs from 'fs';
import { duckdbLogger } from './logger';

export interface DuckDBConfig {
  /**
   * Path to the DuckDB database file
   * Use ':memory:' for in-memory database
   */
  databasePath?: string;
  
  /**
   * Maximum memory DuckDB can use (e.g., '4GB', '8GB')
   */
  memoryLimit?: string;
  
  /**
   * Number of threads DuckDB can use
   */
  threads?: number;
  
  /**
   * Directory for temporary files when spilling to disk
   */
  tempDirectory?: string;
  
  /**
   * Enable/disable query result caching
   */
  enableQueryCache?: boolean;
  
  /**
   * Maximum size of the query cache in MB
   */
  queryCacheSizeMB?: number;
}

export interface EventSchema {
  // Core fields
  event_id?: string;
  timestamp: string;
  source: string;
  stream?: string;
  message: string;
  
  // Common join keys
  request_id?: string;
  trace_id?: string;
  correlation_id?: string;
  session_id?: string;
  user_id?: string;
  account_id?: string;
  
  // Labels as JSON
  labels?: Record<string, any>;
  
  // Metadata
  ingested_at?: string;
}

/**
 * DuckDB-based executor for TimeBridge queries
 * Handles billion-scale datasets with automatic memory management
 */
export class DuckDBExecutor extends EventEmitter {
  private db!: duckdb.Database;
  private conn!: duckdb.Connection;
  private config: DuckDBConfig;
  private isInitialized = false;
  private eventCount = 0;
  private partitions = new Set<string>();

  constructor(config: DuckDBConfig = {}) {
    super();
    
    this.config = {
      databasePath: config.databasePath || ':memory:',
      memoryLimit: config.memoryLimit || '4GB',
      threads: config.threads || 4,
      tempDirectory: config.tempDirectory || path.join(process.cwd(), '.timebridge-temp'),
      enableQueryCache: config.enableQueryCache ?? true,
      queryCacheSizeMB: config.queryCacheSizeMB || 100,
    };

    // Ensure temp directory exists
    if (this.config.tempDirectory) {
      if (!fs.existsSync(this.config.tempDirectory)) {
        fs.mkdirSync(this.config.tempDirectory, { recursive: true });
      }
    }
  }

  /**
   * Initialize DuckDB and create schema
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    return new Promise((resolve, reject) => {
      // Create database
      this.db = new duckdb.Database(this.config.databasePath!, (err) => {
        if (err) {
          return reject(new CorrelationError(
            'Failed to create DuckDB database',
            'DUCKDB_INIT_ERROR',
            { error: err.message }
          ));
        }

        // Create connection
        this.conn = this.db.connect();

        // Configure DuckDB settings
        this.configureDatabase()
          .then(() => this.createSchema())
          .then(() => {
            this.isInitialized = true;
            this.emit('initialized');
            resolve();
          })
          .catch(reject);
      });
    });
  }

  /**
   * Configure DuckDB settings for optimal performance
   */
  private async configureDatabase(): Promise<void> {
    const settings = [
      `SET memory_limit='${this.config.memoryLimit}'`,
      `SET threads=${this.config.threads}`,
      `SET temp_directory='${this.config.tempDirectory}'`,
      'SET enable_progress_bar=false',
      'SET enable_object_cache=true',
      'SET preserve_insertion_order=false', // Better performance
    ];

    for (const setting of settings) {
      await this.execute(setting);
    }

    duckdbLogger.info({ memoryLimit: this.config.memoryLimit, threads: this.config.threads }, "DuckDB configured");
  }

  /**
   * Create the events table and indexes
   */
  private async createSchema(): Promise<void> {
    // Create main events table - minimal schema, with JSON for flexibility
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS events (
        -- Core fields only
        event_id VARCHAR DEFAULT gen_random_uuid(),
        timestamp TIMESTAMP NOT NULL,
        source VARCHAR NOT NULL,
        stream VARCHAR,
        message TEXT,
        
        -- No predefined join key columns - will be added dynamically
        
        -- ALL fields stored as JSON for maximum flexibility
        labels JSON,
        
        -- Metadata
        ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        partition_date DATE GENERATED ALWAYS AS (DATE_TRUNC('day', timestamp))
      )
    `;

    await this.execute(createTableSQL);

    // Create minimal indexes - only what we actually need
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_events_partition ON events(partition_date)',
    ];

    for (const indexSQL of indexes) {
      await this.execute(indexSQL);
    }

    // Create statistics table for query optimization
    const statsTableSQL = `
      CREATE TABLE IF NOT EXISTS event_statistics (
        partition_date DATE,
        source VARCHAR,
        event_count BIGINT,
        unique_request_ids BIGINT,
        unique_trace_ids BIGINT,
        min_timestamp TIMESTAMP,
        max_timestamp TIMESTAMP,
        size_bytes BIGINT,
        PRIMARY KEY (partition_date, source)
      )
    `;

    await this.execute(statsTableSQL);

    duckdbLogger.info('Schema created successfully');
  }

  /**
   * Execute a SQL query
   */
  async execute(sql: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Prepare a SQL statement for repeated execution
   */
  private prepare(sql: string): Promise<duckdb.Statement> {
    return new Promise((resolve, reject) => {
      this.conn.prepare(sql, (err, statement) => {
        if (err) {
          reject(err);
        } else {
          resolve(statement);
        }
      });
    });
  }

  /**
   * Ingest a stream of events into DuckDB
   */
  async *ingestStream(
    stream: AsyncIterable<LogEvent>,
    options: { batchSize?: number; flushInterval?: number } = {}
  ): AsyncGenerator<{ ingested: number; total: number }> {
    const batchSize = options.batchSize || 1000000;  // Default to 1M events per batch
    const flushInterval = options.flushInterval || 1000;

    if (!this.isInitialized) {
      await this.initialize();
    }

    const batch: EventSchema[] = [];
    let lastFlush = Date.now();
    let totalIngested = 0;

    for await (const event of stream) {
      // Convert LogEvent to EventSchema
      const dbEvent: EventSchema = {
        timestamp: event.timestamp,
        source: event.source,
        stream: event.stream,
        message: event.message,
        labels: event.labels,
        
        // Extract common join keys from labels/joinKeys
        request_id: event.labels?.request_id || event.joinKeys?.request_id,
        trace_id: event.labels?.trace_id || event.joinKeys?.trace_id,
        correlation_id: event.labels?.correlation_id || event.joinKeys?.correlation_id,
        session_id: event.labels?.session_id || event.joinKeys?.session_id,
        user_id: event.labels?.user_id || event.joinKeys?.user_id,
        account_id: event.labels?.account_id || event.joinKeys?.account_id,
      };

      batch.push(dbEvent);

      // Flush when batch is full or interval elapsed
      if (batch.length >= batchSize || Date.now() - lastFlush > flushInterval) {
        const ingested = await this.flushBatch(batch);
        totalIngested += ingested;
        batch.length = 0;
        lastFlush = Date.now();
        
        yield { ingested, total: totalIngested };
      }
    }

    // Flush remaining events
    if (batch.length > 0) {
      const ingested = await this.flushBatch(batch);
      totalIngested += ingested;
      yield { ingested, total: totalIngested };
    }
  }

  /**
   * Track which join key columns we have
   */
  private joinKeyColumns = new Set<string>();

  /**
   * Flush a batch of events to DuckDB
   */
  private async flushBatch(batch: EventSchema[]): Promise<number> {
    if (batch.length === 0) return 0;

    // Collect all potential join keys from the batch
    const batchJoinKeys = new Set<string>();
    batch.forEach(event => {
      // Check common join key fields
      ['request_id', 'trace_id', 'correlation_id', 'session_id', 'user_id', 'account_id']
        .forEach(key => {
          if (event[key as keyof EventSchema] || event.labels?.[key]) {
            batchJoinKeys.add(key);
          }
        });
    });

    // Build dynamic column list based on what columns exist
    const availableColumns = Array.from(this.joinKeyColumns);
    const columnsList = ['timestamp', 'source', 'stream', 'message', ...availableColumns, 'labels'];
    
    // Use COPY for efficient bulk insertion
    const values = batch.map(event => {
      const allLabels = { ...event.labels };
      
      // Build values array in the same order as columnsList
      const valuesParts = [
        `'${event.timestamp}'`,
        `'${event.source}'`,
        event.stream ? `'${event.stream}'` : 'NULL',
        `'${event.message.replace(/'/g, "''")}'`,
      ];
      
      // Add values for each dynamic join key column
      availableColumns.forEach(key => {
        const value = event[key as keyof EventSchema] || event.labels?.[key];
        valuesParts.push(value ? `'${value}'` : 'NULL');
      });
      
      // Add JSON labels
      valuesParts.push(allLabels ? `'${JSON.stringify(allLabels)}'` : 'NULL');
      
      return `(${valuesParts.join(', ')})`;
    }).join(',\n');

    const insertSQL = `
      INSERT INTO events (${columnsList.join(', ')}) 
      VALUES ${values}
    `;

    await this.execute(insertSQL);
    this.eventCount += batch.length;

    // Track partitions for statistics
    batch.forEach(event => {
      const date = event.timestamp.split('T')[0];
      this.partitions.add(date);
    });

    this.emit('batchIngested', { count: batch.length, total: this.eventCount });
    
    return batch.length;
  }

  /**
   * Execute a correlation query using SQL
   */
  async *correlate(sql: string): AsyncGenerator<CorrelatedEvent> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const results = await this.execute(sql);
    
    for (const row of results) {
      // Convert SQL result to CorrelatedEvent
      const correlation: CorrelatedEvent = {
        correlationId: row.correlation_id || `corr_${Date.now()}_${Math.random()}`,
        timestamp: row.correlation_timestamp || new Date().toISOString(),
        timeWindow: {
          start: row.window_start,
          end: row.window_end,
        },
        joinKey: row.join_key,
        joinValue: row.join_value,
        events: [], // Would need to parse the joined events
        metadata: {
          completeness: 'complete' as const,
          matchedStreams: [row.left_source, row.right_source].filter(Boolean),
          totalStreams: 2,
        },
      };

      yield correlation;
    }
  }

  /**
   * Get statistics about stored events
   */
  async getStatistics(): Promise<{
    totalEvents: number;
    sources: Array<{ source: string; count: number }>;
    partitions: number;
    memoryUsageMB: number;
    diskUsageMB: number;
  }> {
    const stats = await this.execute(`
      SELECT 
        COUNT(*) as total,
        source,
        COUNT(DISTINCT partition_date) as partitions
      FROM events
      GROUP BY source
    `);

    const dbSize = await this.execute(`
      SELECT 
        0 as db_size,
        0 as mem_usage
    `).catch(() => [{ db_size: 0, mem_usage: 0 }]);

    const sizeInfo = Array.isArray(dbSize) ? dbSize[0] : dbSize;
    
    return {
      totalEvents: this.eventCount,
      sources: stats.map((s: any) => ({ source: s.source, count: Number(s.total) })),
      partitions: this.partitions.size,
      memoryUsageMB: Math.round((sizeInfo?.mem_usage || 0) / 1024 / 1024),
      diskUsageMB: Math.round((sizeInfo?.db_size || 0) / 1024 / 1024),
    };
  }

  /**
   * Ensure columns exist for the given join keys
   * Dynamically adds columns and indexes as needed
   */
  async ensureJoinKeyColumns(joinKeys: string[]): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    for (const joinKey of joinKeys) {
      // Track that we have this column
      this.joinKeyColumns.add(joinKey);
      
      try {
        // Check if column already exists
        const checkColumnSQL = `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'events' 
          AND column_name = '${joinKey}'
        `;
        
        const result = await this.execute(checkColumnSQL);
        
        if (!result || result.length === 0) {
          // Column doesn't exist, add it
          duckdbLogger.info({ joinKey }, "Adding new join key column to events table");
          
          // Add the column
          await this.execute(`ALTER TABLE events ADD COLUMN ${joinKey} VARCHAR`);
          
          // Create an index for it
          await this.execute(`CREATE INDEX IF NOT EXISTS idx_events_${joinKey} ON events(${joinKey})`);
          
          // Try to populate it from existing JSON data if any exists
          try {
            await this.execute(`
              UPDATE events 
              SET ${joinKey} = json_extract_string(labels, '$.${joinKey}')
              WHERE labels IS NOT NULL 
              AND json_extract_string(labels, '$.${joinKey}') IS NOT NULL
            `);
            
            const updatedRows = await this.execute(`SELECT COUNT(*) as count FROM events WHERE ${joinKey} IS NOT NULL`);
            duckdbLogger.info({ joinKey, rowsUpdated: updatedRows[0]?.count || 0 }, "Populated join key column from existing data");
          } catch (error) {
            duckdbLogger.warn({ joinKey, error }, "Could not populate join key from existing data");
          }
        } else {
          duckdbLogger.debug({ joinKey }, "Join key column already exists");
        }
      } catch (error) {
        duckdbLogger.error({ joinKey, error }, "Failed to ensure join key column");
        // Continue with other keys even if one fails
      }
    }
  }

  /**
   * Get the underlying DuckDB connection
   */
  getConnection(): duckdb.Connection {
    if (!this.conn) {
      throw new Error('DuckDB not initialized. Call initialize() first.');
    }
    return this.conn;
  }

  /**
   * Clean up and close database
   */
  async destroy(): Promise<void> {
    return new Promise((resolve) => {
      if (this.conn) {
        this.conn.close(() => {
          if (this.db) {
            this.db.close(() => {
              this.isInitialized = false;
              this.removeAllListeners();
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Clear all events (useful for testing)
   */
  async clearEvents(): Promise<void> {
    await this.execute('DELETE FROM events');
    await this.execute('DELETE FROM event_statistics');
    this.eventCount = 0;
    this.partitions.clear();
  }
}