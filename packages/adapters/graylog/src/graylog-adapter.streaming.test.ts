import { GraylogAdapter } from './graylog-adapter';

describe('GraylogAdapter Streaming', () => {
  let adapter: GraylogAdapter;

  beforeEach(() => {
    adapter = new GraylogAdapter({
      url: 'http://localhost:9000',
      username: 'admin',
      password: 'admin',
      apiVersion: 'v6',
      fields: ['timestamp', 'message', 'request_id', 'level'],
      maxResults: 50000
    });
  });

  afterEach(async () => {
    await adapter.destroy();
  });

  describe('streamParseCSVText', () => {
    it('should parse CSV data as a stream without loading all objects into memory', async () => {
      // Create a large CSV with many rows
      const headers = 'timestamp,message,request_id,level';
      const rows: string[] = [headers];
      
      // Generate 10,000 test rows
      for (let i = 0; i < 10000; i++) {
        rows.push(`2024-01-01T00:00:${String(i).padStart(2, '0')}Z,Message ${i},req_${i},INFO`);
      }
      
      const csvText = rows.join('\n');
      const signal = new AbortController().signal;

      // Access private method for testing
      const parseMethod = (adapter as any).streamParseCSVText.bind(adapter);
      
      let messageCount = 0;
      const memoryBefore = process.memoryUsage().heapUsed;
      
      for await (const messageWrapper of parseMethod(csvText, signal)) {
        messageCount++;
        
        // Verify message structure
        expect(messageWrapper.message).toBeDefined();
        expect(messageWrapper.message.timestamp).toBeDefined();
        expect(messageWrapper.message.fields).toBeDefined();
        expect(messageWrapper.message.fields.request_id).toMatch(/^req_\d+$/);
        
        // Only check first few messages
        if (messageCount >= 10) break;
      }
      
      const memoryAfter = process.memoryUsage().heapUsed;
      const memoryIncreaseMB = (memoryAfter - memoryBefore) / 1024 / 1024;
      
      expect(messageCount).toBe(10);
      // Memory increase should be minimal since we're using generators
      expect(memoryIncreaseMB).toBeLessThan(50); // Should use less than 50MB for 10K rows
    });

    it('should handle CSV with quoted fields correctly', async () => {
      const csvText = `timestamp,message,request_id,level
2024-01-01T00:00:00Z,"Message with, comma",req_123,INFO
2024-01-01T00:00:01Z,"Message with ""quotes""",req_124,ERROR`;
      
      const signal = new AbortController().signal;
      const parseMethod = (adapter as any).streamParseCSVText.bind(adapter);
      
      const messages: any[] = [];
      for await (const messageWrapper of parseMethod(csvText, signal)) {
        messages.push(messageWrapper.message);
      }
      
      expect(messages).toHaveLength(2);
      expect(messages[0].message).toBe('Message with, comma');
      expect(messages[1].message).toBe('Message with "quotes"');
      expect(messages[0].fields.request_id).toBe('req_123');
      expect(messages[1].fields.request_id).toBe('req_124');
    });

    it('should clear processed lines from memory periodically', async () => {
      // Generate a large CSV
      const headers = 'timestamp,message,request_id';
      const rows: string[] = [headers];
      
      // Generate 5000 rows
      for (let i = 0; i < 5000; i++) {
        rows.push(`2024-01-01T00:00:00Z,Message ${i},req_${i}`);
      }
      
      const csvText = rows.join('\n');
      const signal = new AbortController().signal;
      
      const parseMethod = (adapter as any).streamParseCSVText.bind(adapter);
      
      let messageCount = 0;
      const memorySnapshots: number[] = [];
      
      for await (const _messageWrapper of parseMethod(csvText, signal)) {
        messageCount++;
        
        // Take memory snapshots every 1000 messages
        if (messageCount % 1000 === 0) {
          memorySnapshots.push(process.memoryUsage().heapUsed);
        }
      }
      
      expect(messageCount).toBe(5000);
      expect(memorySnapshots.length).toBe(5);
      
      // Memory should not continuously increase
      // The last snapshot should not be significantly higher than the first
      const firstSnapshot = memorySnapshots[0];
      const lastSnapshot = memorySnapshots[memorySnapshots.length - 1];
      const increaseMB = (lastSnapshot - firstSnapshot) / 1024 / 1024;
      
      // Should not increase by more than 20MB for 5000 rows
      expect(increaseMB).toBeLessThan(20);
    });

    it('should handle abort signal correctly', async () => {
      const headers = 'timestamp,message,request_id';
      const rows: string[] = [headers];
      
      // Generate many rows
      for (let i = 0; i < 1000; i++) {
        rows.push(`2024-01-01T00:00:00Z,Message ${i},req_${i}`);
      }
      
      const csvText = rows.join('\n');
      const abortController = new AbortController();
      
      const parseMethod = (adapter as any).streamParseCSVText.bind(adapter);
      
      let messageCount = 0;
      let errorThrown = false;
      
      try {
        for await (const _messageWrapper of parseMethod(csvText, abortController.signal)) {
          messageCount++;
          
          // Abort after 100 messages
          if (messageCount === 100) {
            abortController.abort();
          }
        }
      } catch (error: any) {
        errorThrown = true;
        expect(error.message).toBe('Operation aborted');
      }
      
      expect(errorThrown).toBe(true);
      expect(messageCount).toBe(100);
    });
  });
});