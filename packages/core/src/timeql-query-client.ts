import { DuckDBExecutor } from './duckdb-executor';
import { TimeQLToSQLGenerator } from './timeql-to-sql';
import { PeggyQueryParser } from '@timebridge/timeql-parser';
import { ParsedQuery } from './types';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

export interface TimeQLQueryClientConfig {
  /**
   * Path to persisted database directory
   */
  databasePath?: string;
  
  /**
   * DuckDB configuration
   */
  duckdbConfig?: {
    memoryLimit?: string;
    threads?: number;
  };
}

export interface DatabaseInfo {
  name: string;
  path: string;
  createdAt?: string;
  sizeBytes?: number;
  eventCount?: number;
  tables?: string[];
}

/**
 * Client for querying persisted TimeQL databases
 * Allows executing TimeQL and SQL queries on previously persisted data
 */
export class TimeQLQueryClient {
  private executor: DuckDBExecutor;
  private sqlGenerator: TimeQLToSQLGenerator;
  private parser: PeggyQueryParser;
  private config: TimeQLQueryClientConfig;
  private isConnected: boolean = false;
  private currentDatabase?: string;
  
  constructor(config: TimeQLQueryClientConfig = {}) {
    this.config = {
      databasePath: config.databasePath || path.join(os.tmpdir(), 'timebridge_persist'),
      duckdbConfig: config.duckdbConfig || {}
    };
    
    this.executor = new DuckDBExecutor({
      databasePath: ':memory:', // Start with in-memory, will load persisted DBs
      ...this.config.duckdbConfig
    });
    
    this.sqlGenerator = new TimeQLToSQLGenerator();
    this.parser = new PeggyQueryParser();
  }
  
  /**
   * Initialize the client
   */
  async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.executor.initialize();
      this.isConnected = true;
    }
  }
  
  /**
   * List available persisted databases
   */
  async listDatabases(): Promise<DatabaseInfo[]> {
    const dbPath = this.config.databasePath!;
    
    try {
      await fs.access(dbPath);
    } catch {
      // Directory doesn't exist
      return [];
    }
    
    const files = await fs.readdir(dbPath);
    const databases: DatabaseInfo[] = [];
    
    for (const file of files) {
      if (file.endsWith('.duckdb')) {
        const fullPath = path.join(dbPath, file);
        const stats = await fs.stat(fullPath);
        
        // Try to read metadata file if it exists
        const metaPath = fullPath.replace('.duckdb', '.meta.json');
        let metadata: any = {};
        
        try {
          const metaContent = await fs.readFile(metaPath, 'utf-8');
          metadata = JSON.parse(metaContent);
        } catch {
          // No metadata file
        }
        
        databases.push({
          name: file.replace('.duckdb', ''),
          path: fullPath,
          createdAt: metadata.createdAt || stats.birthtime.toISOString(),
          sizeBytes: stats.size,
          eventCount: metadata.eventCount,
          tables: metadata.tables
        });
      }
    }
    
    // Sort by creation date (newest first)
    databases.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0).getTime();
      const dateB = new Date(b.createdAt || 0).getTime();
      return dateB - dateA;
    });
    
    return databases;
  }
  
  /**
   * Load a persisted database for querying
   */
  async loadDatabase(nameOrPath: string): Promise<void> {
    await this.connect();
    
    let dbPath = nameOrPath;
    
    // If it's just a name, build the full path
    if (!nameOrPath.includes('/')) {
      const dbName = nameOrPath.endsWith('.duckdb') ? nameOrPath : `${nameOrPath}.duckdb`;
      dbPath = path.join(this.config.databasePath!, dbName);
    }
    
    await this.executor.loadFromDisk(dbPath);
    this.currentDatabase = dbPath;
  }
  
  /**
   * Execute a TimeQL query on the loaded database
   */
  async query(timeql: string): Promise<any[]> {
    if (!this.isConnected) {
      await this.connect();
    }
    
    // Parse the TimeQL query
    const parsedQuery = this.parser.parse(timeql);
    
    // Generate SQL from the parsed query
    const sql = this.sqlGenerator.generateSQL(parsedQuery);
    
    // Execute the SQL
    return await this.executor.execute(sql);
  }
  
  /**
   * Execute a raw SQL query on the loaded database
   */
  async sql(query: string): Promise<any[]> {
    if (!this.isConnected) {
      await this.connect();
    }
    
    return await this.executor.execute(query);
  }
  
  /**
   * Get metadata about the currently loaded database
   */
  async getMetadata(): Promise<any> {
    if (!this.isConnected) {
      await this.connect();
    }
    
    return await this.executor.getDatabaseMetadata();
  }
  
  /**
   * Create a new database from a TimeQL streaming query
   * This allows creating a persisted database from live data
   */
  async createDatabaseFromQuery(
    name: string,
    query: string,
    adapters: Map<string, any>
  ): Promise<string> {
    // This would use QueryRouter with persistData enabled
    const { QueryRouter } = await import('./query-router');
    
    const router = new QueryRouter({
      forceEngine: 'duckdb',
      persistData: true,
      persistPath: this.config.databasePath,
      databaseName: name
    });
    
    // Parse and execute the query
    const parsedQuery = this.parser.parse(query);
    
    // Collect all results (forces full execution)
    const results = [];
    for await (const result of router.execute(parsedQuery, adapters)) {
      results.push(result);
    }
    
    const dbPath = path.join(this.config.databasePath!, `${name}.duckdb`);
    
    // Create metadata file
    const metadata = {
      name,
      createdAt: new Date().toISOString(),
      query,
      resultCount: results.length,
      path: dbPath
    };
    
    await fs.writeFile(
      dbPath.replace('.duckdb', '.meta.json'),
      JSON.stringify(metadata, null, 2)
    );
    
    return dbPath;
  }
  
  /**
   * Close the client and clean up resources
   */
  async close(): Promise<void> {
    if (this.isConnected) {
      await this.executor.close();
      this.isConnected = false;
    }
  }
  
  /**
   * Delete a persisted database
   */
  async deleteDatabase(name: string): Promise<void> {
    const dbPath = path.join(this.config.databasePath!, `${name}.duckdb`);
    const metaPath = dbPath.replace('.duckdb', '.meta.json');
    const exportPath = dbPath.replace('.duckdb', '_export');
    
    // Delete all related files
    try {
      await fs.unlink(dbPath);
    } catch {}
    
    try {
      await fs.unlink(metaPath);
    } catch {}
    
    try {
      await fs.rmdir(exportPath, { recursive: true } as any);
    } catch {}
  }
  
  /**
   * Export a database to a new location
   */
  async exportDatabase(name: string, exportPath: string): Promise<void> {
    await this.loadDatabase(name);
    await this.executor.exportDatabase(exportPath);
  }
  
  /**
   * Import a database from an external file
   */
  async importDatabase(importPath: string, name?: string): Promise<void> {
    await this.connect();
    
    // Import the database
    await this.executor.importDatabase(importPath);
    
    // If a name is provided, export to our managed directory
    if (name) {
      const dbPath = path.join(this.config.databasePath!, `${name}.duckdb`);
      await this.executor.exportDatabase(dbPath);
    }
  }
}

/**
 * Convenience function to create a query client and execute a query
 */
export async function queryPersistedData(
  databaseName: string,
  query: string,
  options?: TimeQLQueryClientConfig
): Promise<any[]> {
  const client = new TimeQLQueryClient(options);
  
  try {
    await client.loadDatabase(databaseName);
    return await client.query(query);
  } finally {
    await client.close();
  }
}