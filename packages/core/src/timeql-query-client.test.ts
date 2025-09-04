import { TimeQLQueryClient } from './timeql-query-client';
import { DuckDBExecutor } from './duckdb-executor';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('TimeQLQueryClient', () => {
  let client: TimeQLQueryClient;
  let testDbPath: string;

  beforeEach(async () => {
    // Create a temporary directory for test databases
    testDbPath = path.join(os.tmpdir(), 'timeql_test_' + Date.now());
    await fs.mkdir(testDbPath, { recursive: true });
    
    client = new TimeQLQueryClient({
      databasePath: testDbPath,
      duckdbConfig: { memoryLimit: '1GB' }
    });
  });

  afterEach(async () => {
    // Clean up
    if (client) {
      await client.close();
    }
    
    try {
      await fs.rm(testDbPath, { recursive: true });
    } catch {}
  });

  describe('Database Management', () => {
    test('should list empty databases initially', async () => {
      const databases = await client.listDatabases();
      expect(databases).toEqual([]);
    });

    test('should load and query a database', async () => {
      // First create a test database
      const executor = new DuckDBExecutor({ databasePath: ':memory:' });
      await executor.initialize();
      
      // Insert test data
      await executor.execute(`
        CREATE TABLE events AS 
        SELECT 
          'test-source' as source,
          '{"service": "api", "level": "info"}' as labels,
          'Test message' as message,
          NOW() as timestamp
      `);
      
      const dbFile = path.join(testDbPath, 'test.duckdb');
      await executor.exportDatabase(dbFile);
      await executor.close();
      
      // Now use the client to query it
      await client.loadDatabase('test');
      const results = await client.sql('SELECT COUNT(*) as count FROM events');
      
      expect(results).toHaveLength(1);
      expect(results[0].count).toBe(1);
    });

    test('should delete a database', async () => {
      // Create a dummy database file
      const dbFile = path.join(testDbPath, 'test.duckdb');
      await fs.writeFile(dbFile, 'dummy content');
      
      // Verify it exists
      let databases = await client.listDatabases();
      expect(databases).toHaveLength(1);
      expect(databases[0].name).toBe('test');
      
      // Delete it
      await client.deleteDatabase('test');
      
      // Verify it's gone
      databases = await client.listDatabases();
      expect(databases).toHaveLength(0);
    });

    test('should export and import databases', async () => {
      // Create a test database
      const executor = new DuckDBExecutor({ databasePath: ':memory:' });
      await executor.initialize();
      
      await executor.execute(`
        CREATE TABLE events AS 
        SELECT 
          'export-test' as source,
          '{"service": "export"}' as labels,
          'Export test' as message,
          NOW() as timestamp
      `);
      
      const originalDb = path.join(testDbPath, 'original.duckdb');
      await executor.exportDatabase(originalDb);
      await executor.close();
      
      // Export it to a new location
      await client.loadDatabase('original');
      const exportPath = path.join(testDbPath, 'exported.duckdb');
      await client.exportDatabase('original', exportPath);
      
      // Import it with a new name
      await client.importDatabase(exportPath, 'imported');
      
      // Verify both databases exist
      const databases = await client.listDatabases();
      const dbNames = databases.map(db => db.name);
      expect(dbNames).toContain('original');
      expect(dbNames).toContain('imported');
    });

    test('should get database metadata', async () => {
      // Create a test database with some data
      const executor = new DuckDBExecutor({ databasePath: ':memory:' });
      await executor.initialize();
      
      await executor.execute(`
        CREATE TABLE events (
          source TEXT,
          labels TEXT,
          message TEXT,
          timestamp TIMESTAMP
        )
      `);
      
      await executor.execute(`
        INSERT INTO events VALUES 
        ('test1', '{}', 'Message 1', NOW()),
        ('test2', '{}', 'Message 2', NOW())
      `);
      
      const dbFile = path.join(testDbPath, 'metadata-test.duckdb');
      await executor.exportDatabase(dbFile);
      await executor.close();
      
      // Load and get metadata
      await client.loadDatabase('metadata-test');
      const metadata = await client.getMetadata();
      
      expect(metadata.isInMemory).toBe(false);
      expect(metadata.tables).toContain('events');
    });
  });

  describe('TimeQL Query Execution', () => {
    let testDb: DuckDBExecutor;

    beforeEach(async () => {
      // Create a test database with sample data
      testDb = new DuckDBExecutor({ databasePath: ':memory:' });
      await testDb.initialize();
      
      await testDb.execute(`
        CREATE TABLE events (
          source TEXT,
          labels TEXT,
          message TEXT,
          timestamp TIMESTAMP
        )
      `);
      
      // Insert test events
      const now = new Date();
      const events = [
        { source: 'api', labels: '{"service": "api", "level": "info", "endpoint": "/users"}', message: 'GET /users', timestamp: new Date(now.getTime() - 60000) },
        { source: 'api', labels: '{"service": "api", "level": "error", "endpoint": "/users"}', message: 'Error in /users', timestamp: new Date(now.getTime() - 30000) },
        { source: 'database', labels: '{"service": "database", "level": "info", "query": "SELECT"}', message: 'Query executed', timestamp: new Date(now.getTime() - 45000) },
        { source: 'auth', labels: '{"service": "auth", "level": "info", "action": "login"}', message: 'User login', timestamp: new Date(now.getTime() - 20000) },
        { source: 'auth', labels: '{"service": "auth", "level": "info", "action": "logout"}', message: 'User logout', timestamp: now }
      ];
      
      for (const event of events) {
        await testDb.execute(`
          INSERT INTO events VALUES (
            '${event.source}',
            '${event.labels}',
            '${event.message}',
            TIMESTAMP '${event.timestamp.toISOString()}'
          )
        `);
      }
      
      const dbFile = path.join(testDbPath, 'query-test.duckdb');
      await testDb.exportDatabase(dbFile);
      await testDb.close();
      
      await client.loadDatabase('query-test');
    });

    test('should execute basic TimeQL queries', async () => {
      const query = 'events{service="api"}[1h]';
      const results = await client.query(query);
      
      expect(results).toHaveLength(2);
      expect(results.every(r => r.source === 'api')).toBe(true);
    });

    test('should execute aggregation queries', async () => {
      const query = 'count by(service) (events[1h])';
      const results = await client.query(query);
      
      expect(results).toHaveLength(3); // api, database, auth
      expect(results.find(r => r.service === 'api').count).toBe(2);
      expect(results.find(r => r.service === 'auth').count).toBe(2);
      expect(results.find(r => r.service === 'database').count).toBe(1);
    });

    test('should execute raw SQL queries', async () => {
      const sql = `
        SELECT source, COUNT(*) as event_count 
        FROM events 
        GROUP BY source 
        ORDER BY event_count DESC
      `;
      const results = await client.sql(sql);
      
      expect(results).toHaveLength(3);
      expect(results[0].source).toBe('api');
      expect(results[0].event_count).toBe(2);
    });

    test('should handle queries with no results', async () => {
      const query = 'events{service="nonexistent"}[1h]';
      const results = await client.query(query);
      
      expect(results).toEqual([]);
    });

    test('should handle invalid queries gracefully', async () => {
      await expect(client.query('invalid query syntax')).rejects.toThrow();
    });
  });

  describe('Database Creation from Queries', () => {
    test('should create a database from a streaming query', async () => {
      // Mock adapters map
      const mockAdapters = new Map([
        ['test-source', {
          createStream: async function* () {
            yield { 
              timestamp: new Date(), 
              message: 'Test event', 
              labels: { service: 'test' } 
            };
          },
          validateQuery: () => true,
          getName: () => 'test-source',
          destroy: async () => {}
        }]
      ]);

      const query = 'test-source{service="test"}[5m]';
      const dbPath = await client.createDatabaseFromQuery('stream-test', query, mockAdapters);
      
      expect(dbPath).toContain('stream-test.duckdb');
      
      // Verify the database was created
      const databases = await client.listDatabases();
      expect(databases.some(db => db.name === 'stream-test')).toBe(true);
      
      // Verify metadata was created
      const metaPath = dbPath.replace('.duckdb', '.meta.json');
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const metadata = JSON.parse(metaContent);
      expect(metadata.name).toBe('stream-test');
      expect(metadata.query).toBe(query);
    });
  });

  describe('Connection Management', () => {
    test('should connect lazily on first operation', async () => {
      const newClient = new TimeQLQueryClient({ databasePath: testDbPath });
      
      // Client should not be connected initially
      expect((newClient as any).isConnected).toBe(false);
      
      // Should connect when listing databases
      await newClient.listDatabases();
      expect((newClient as any).isConnected).toBe(true);
      
      await newClient.close();
    });

    test('should handle multiple connect calls gracefully', async () => {
      await client.connect();
      await client.connect(); // Should not throw
      
      expect((client as any).isConnected).toBe(true);
    });

    test('should close connection properly', async () => {
      await client.connect();
      expect((client as any).isConnected).toBe(true);
      
      await client.close();
      expect((client as any).isConnected).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should handle non-existent database gracefully', async () => {
      await expect(client.loadDatabase('nonexistent')).rejects.toThrow();
    });

    test('should handle invalid database path', async () => {
      const invalidClient = new TimeQLQueryClient({
        databasePath: '/invalid/path/that/does/not/exist'
      });
      
      const databases = await invalidClient.listDatabases();
      expect(databases).toEqual([]);
      
      await invalidClient.close();
    });

    test('should handle corrupted metadata gracefully', async () => {
      // Create a database file without metadata
      const dbFile = path.join(testDbPath, 'no-meta.duckdb');
      await fs.writeFile(dbFile, 'dummy content');
      
      const databases = await client.listDatabases();
      expect(databases).toHaveLength(1);
      expect(databases[0].name).toBe('no-meta');
      expect(databases[0].eventCount).toBeUndefined();
    });
  });
});

describe('queryPersistedData helper', () => {
  let testDbPath: string;
  let testDb: DuckDBExecutor;

  beforeEach(async () => {
    testDbPath = path.join(os.tmpdir(), 'timeql_helper_test_' + Date.now());
    await fs.mkdir(testDbPath, { recursive: true });
    
    // Create a test database
    testDb = new DuckDBExecutor({ databasePath: ':memory:' });
    await testDb.initialize();
    
    await testDb.execute(`
      CREATE TABLE events AS 
      SELECT 
        'test-source' as source,
        '{"service": "api"}' as labels,
        'Test message' as message,
        NOW() as timestamp
    `);
    
    const dbFile = path.join(testDbPath, 'helper-test.duckdb');
    await testDb.exportDatabase(dbFile);
    await testDb.close();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDbPath, { recursive: true });
    } catch {}
  });

  test('should execute query and return results', async () => {
    const { queryPersistedData } = await import('./timeql-query-client');
    
    const results = await queryPersistedData(
      'helper-test',
      'events{service="api"}[1h]',
      { databasePath: testDbPath }
    );
    
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('test-source');
  });

  test('should auto-close connection after query', async () => {
    const { queryPersistedData } = await import('./timeql-query-client');
    
    await queryPersistedData(
      'helper-test',
      'events[1h]',
      { databasePath: testDbPath }
    );
    
    // The client should be closed, so creating a new one should work
    const client = new TimeQLQueryClient({ databasePath: testDbPath });
    await client.loadDatabase('helper-test');
    const results = await client.sql('SELECT COUNT(*) as count FROM events');
    expect(results[0].count).toBe(1);
    await client.close();
  });
});