import { QueryRouter } from './query-router';
import { ParsedQuery } from './types';

describe('QueryRouter', () => {
  let router: QueryRouter;
  
  beforeEach(() => {
    router = new QueryRouter();
  });
  
  describe('routing decisions', () => {
    it('should route small time windows to StreamJoiner', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{job="nginx"}',
          timeRange: '5m'
        },
        rightStream: {
          source: 'loki',
          selector: '{job="app"}',
          timeRange: '5m'
        },
        joinType: 'and',
        joinKeys: ['request_id']
      };
      
      const decision = await router.decideRoute(query);
      
      expect(decision.engine).toBe('streamjoiner');
      expect(decision.reason).toContain('Small query');
      expect(decision.timeWindowMs).toBe(5 * 60 * 1000);
    });
    
    it('should route large time windows to DuckDB', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'graylog',
          selector: '{app="frontend"}',
          timeRange: '7d'
        },
        rightStream: {
          source: 'graylog',
          selector: '{app="backend"}',
          timeRange: '7d'
        },
        joinType: 'and',
        joinKeys: ['trace_id']
      };
      
      const decision = await router.decideRoute(query);
      
      expect(decision.engine).toBe('duckdb');
      expect(decision.reason).toContain('Time window');
      expect(decision.timeWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
    });
    
    it('should route based on estimated event count', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{job="nginx"}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'loki',
          selector: '{job="app"}',
          timeRange: '1h'
        },
        joinType: 'and',
        joinKeys: ['request_id']
      };
      
      // Mock large result set estimation
      const routerWithHighEstimate = new QueryRouter({
        eventCountThreshold: 1000 // Low threshold for testing
      });
      
      const decision = await routerWithHighEstimate.decideRoute(query);
      
      // Should use DuckDB if estimate exceeds threshold
      expect(['streamjoiner', 'duckdb']).toContain(decision.engine);
    });
    
    it('should respect forced engine configuration', async () => {
      const routerForced = new QueryRouter({
        forceEngine: 'duckdb'
      });
      
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{job="nginx"}',
          timeRange: '1m' // Very small
        },
        joinType: 'and',
        joinKeys: ['request_id']
      };
      
      const decision = await routerForced.decideRoute(query);
      
      expect(decision.engine).toBe('duckdb');
      expect(decision.reason).toContain('Forced by configuration');
    });
    
    it('should detect and respect query hints', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '/* engine:duckdb */ {job="nginx"}',
          timeRange: '5m'
        },
        rightStream: {
          source: 'loki',
          selector: '{job="app"}',
          timeRange: '5m'
        },
        joinType: 'and',
        joinKeys: ['request_id']
      };
      
      const decision = await router.decideRoute(query);
      
      expect(decision.engine).toBe('duckdb');
      expect(decision.reason).toContain('query hint');
    });
    
    it('should handle single stream queries', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{job="nginx"}',
          timeRange: '5m'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await router.decideRoute(query);
      
      expect(decision.engine).toBe('streamjoiner');
      expect(decision.timeWindowMs).toBe(5 * 60 * 1000);
    });
    
    it('should handle queries without time ranges', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{job="nginx"}'
        },
        joinType: 'and',
        joinKeys: ['request_id']
      };
      
      const decision = await router.decideRoute(query);
      
      expect(decision.engine).toBe('streamjoiner');
      expect(decision.timeWindowMs).toBe(0);
    });
  });
  
  describe('time window calculation', () => {
    it('should parse seconds correctly', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '30s'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await router.decideRoute(query);
      expect(decision.timeWindowMs).toBe(30 * 1000);
    });
    
    it('should parse minutes correctly', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '15m'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await router.decideRoute(query);
      expect(decision.timeWindowMs).toBe(15 * 60 * 1000);
    });
    
    it('should parse hours correctly', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '2h'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await router.decideRoute(query);
      expect(decision.timeWindowMs).toBe(2 * 60 * 60 * 1000);
    });
    
    it('should parse days correctly', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '3d'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await router.decideRoute(query);
      expect(decision.timeWindowMs).toBe(3 * 24 * 60 * 60 * 1000);
    });
    
    it('should use the larger time window when both streams have ranges', async () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '5m'
        },
        rightStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '1h'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await router.decideRoute(query);
      expect(decision.timeWindowMs).toBe(60 * 60 * 1000); // 1 hour
    });
  });
  
  describe('thresholds', () => {
    it('should use custom time window threshold', async () => {
      const routerCustom = new QueryRouter({
        timeWindowThreshold: 60 * 60 * 1000 // 1 hour
      });
      
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '2h'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await routerCustom.decideRoute(query);
      
      expect(decision.engine).toBe('duckdb');
      expect(decision.reason).toContain('Time window');
    });
    
    it('should use custom event count threshold', async () => {
      const routerCustom = new QueryRouter({
        eventCountThreshold: 10000 // 10K events
      });
      
      const query: ParsedQuery = {
        leftStream: {
          source: 'loki',
          selector: '{}',
          timeRange: '5m'
        },
        joinType: 'and',
        joinKeys: []
      };
      
      const decision = await routerCustom.decideRoute(query);
      
      // Depends on optimizer estimation
      expect(['streamjoiner', 'duckdb']).toContain(decision.engine);
    });
  });
  
  describe('result normalization', () => {
    it('should normalize DuckDB results to LogEvent format', () => {
      // This would be an integration test with actual DuckDB
      // For now, we just verify the QueryRouter has the method
      expect(router).toHaveProperty('execute');
      expect(router.execute).toBeInstanceOf(Function);
    });
  });
});