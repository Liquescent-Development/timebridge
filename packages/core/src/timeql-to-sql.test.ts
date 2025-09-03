import { TimeQLToSQLGenerator, SQLGeneratorOptions } from './timeql-to-sql';
import { ParsedQuery, JoinType } from './types';

describe('TimeQLToSQLGenerator', () => {
  let generator: TimeQLToSQLGenerator;

  beforeEach(() => {
    generator = new TimeQLToSQLGenerator();
  });

  describe('Basic SQL Generation', () => {
    it('should generate simple INNER JOIN query', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'frontend',
          selector: '{app="frontend"}',
          timeRange: '5m'
        },
        rightStream: {
          source: 'backend',
          selector: '{app="backend"}',
          timeRange: '5m'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id']
      };

      const sql = generator.generateSQL(query);
      
      expect(sql).toContain('WITH');
      expect(sql).toContain('left_stream AS (');
      expect(sql).toContain('right_stream AS (');
      expect(sql).toContain('INNER JOIN');
      expect(sql).toContain("source = 'frontend'");
      expect(sql).toContain("source = 'backend'");
      expect(sql).toContain('l.request_id = r.request_id');
      expect(sql).toContain("INTERVAL '5 minutes'");
      expect(sql).toContain('ORDER BY l.timestamp');
    });

    it('should generate LEFT JOIN query for OR join type', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'app1',
          selector: '{service="app1"}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'app2',
          selector: '{service="app2"}',
          timeRange: '1h'
        },
        joinType: 'or' as JoinType,
        joinKeys: ['trace_id']
      };

      const sql = generator.generateSQL(query);
      
      expect(sql).toContain('LEFT JOIN');
      expect(sql).toContain('l.trace_id = r.trace_id');
      expect(sql).toContain("INTERVAL '1 hours'");
    });

    it('should generate ANTI JOIN query for UNLESS join type', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'requests',
          selector: '{type="request"}',
          timeRange: '30m'
        },
        rightStream: {
          source: 'responses',
          selector: '{type="response"}',
          timeRange: '30m'
        },
        joinType: 'unless' as JoinType,
        joinKeys: ['correlation_id']
      };

      const sql = generator.generateSQL(query);
      
      expect(sql).toContain('WHERE NOT EXISTS');
      expect(sql).toContain('l.correlation_id = r.correlation_id');
      expect(sql).toContain("INTERVAL '30 minutes'");
      expect(sql).not.toContain('JOIN');
    });
  });

  describe('Time Window Parsing', () => {
    it('should parse seconds correctly', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}',
          timeRange: '30s'
        },
        rightStream: {
          source: 'test2',
          selector: '{}',
          timeRange: '45s'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("INTERVAL '30 seconds'");
    });

    it('should parse minutes correctly', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}',
          timeRange: '15m'
        },
        rightStream: {
          source: 'test2',
          selector: '{}',
          timeRange: '15m'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("INTERVAL '15 minutes'");
    });

    it('should parse hours correctly', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}',
          timeRange: '2h'
        },
        rightStream: {
          source: 'test2',
          selector: '{}',
          timeRange: '2h'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("INTERVAL '2 hours'");
    });

    it('should parse days correctly', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}',
          timeRange: '7d'
        },
        rightStream: {
          source: 'test2',
          selector: '{}',
          timeRange: '7d'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("INTERVAL '7 days'");
    });

    it('should handle queries without time range', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}'
        },
        rightStream: {
          source: 'test2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).not.toContain('INTERVAL');
      expect(sql).toContain('INNER JOIN');
    });

    it('should handle invalid time range format gracefully', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}',
          timeRange: 'invalid'
        },
        rightStream: {
          source: 'test2',
          selector: '{}',
          timeRange: 'invalid'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).not.toContain('INTERVAL');
    });
  });

  describe('Native Query Translation', () => {
    it('should handle simple key-value selectors', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'webapp',
          selector: '{app="frontend", level="error"}'
        },
        rightStream: {
          source: 'database',
          selector: '{service="db", operation="query"}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("json_extract_string(labels, '$.app') = 'frontend'");
      expect(sql).toContain("json_extract_string(labels, '$.level') = 'error'");
      expect(sql).toContain("json_extract_string(labels, '$.service') = 'db'");
      expect(sql).toContain("json_extract_string(labels, '$.operation') = 'query'");
    });

    it('should handle negation in selectors', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'logs',
          selector: '{level!="debug", app="prod"}'
        },
        rightStream: {
          source: 'metrics',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['trace_id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("json_extract_string(labels, '$.level') != 'debug'");
      expect(sql).toContain("json_extract_string(labels, '$.app') = 'prod'");
    });

    it('should handle regex patterns in selectors', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'nginx',
          selector: '{path~="/api/.*", method="GET"}'
        },
        rightStream: {
          source: 'backend',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("json_extract_string(labels, '$.path') ~ '/api/.*'");
      expect(sql).toContain("json_extract_string(labels, '$.method') = 'GET'");
    });

    it('should handle empty selectors', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'logs',
          selector: '{}'
        },
        rightStream: {
          source: 'metrics',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("source = 'logs'");
      expect(sql).toContain("source = 'metrics'");
      expect(sql).not.toContain('json_extract_string');
    });

    it('should handle selectors with quoted values containing commas', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'app',
          selector: '{message="error, please retry", status="500"}'
        },
        rightStream: {
          source: 'monitoring',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("json_extract_string(labels, '$.message') = 'error, please retry'");
      expect(sql).toContain("json_extract_string(labels, '$.status') = '500'");
    });
  });

  describe('Temporal Joins with within() clauses', () => {
    it('should generate temporal constraints for INNER JOIN', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'requests',
          selector: '{type="request"}'
        },
        rightStream: {
          source: 'responses',
          selector: '{type="response"}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['session_id'],
        temporal: '30s'
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('INNER JOIN');
      expect(sql).toContain('l.session_id = r.session_id');
      expect(sql).toContain("r.timestamp BETWEEN l.timestamp - INTERVAL '30 seconds'");
      expect(sql).toContain("AND l.timestamp + INTERVAL '30 seconds'");
    });

    it('should generate temporal constraints for LEFT JOIN', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'events',
          selector: '{}'
        },
        rightStream: {
          source: 'responses',
          selector: '{}'
        },
        joinType: 'or' as JoinType,
        joinKeys: ['correlation_id'],
        temporal: '1m'
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('LEFT JOIN');
      expect(sql).toContain("r.timestamp BETWEEN l.timestamp - INTERVAL '1 minutes'");
    });

    it('should generate temporal constraints for ANTI JOIN', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'attempts',
          selector: '{type="login"}'
        },
        rightStream: {
          source: 'successes',
          selector: '{type="success"}'
        },
        joinType: 'unless' as JoinType,
        joinKeys: ['user_id'],
        temporal: '5m'
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('WHERE NOT EXISTS');
      expect(sql).toContain("r.timestamp BETWEEN l.timestamp - INTERVAL '5 minutes'");
    });

    it('should handle queries without temporal constraints', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'logs1',
          selector: '{}'
        },
        rightStream: {
          source: 'logs2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('INNER JOIN');
      expect(sql).not.toContain('BETWEEN');
    });
  });

  describe('Multi-stream Queries', () => {
    it('should generate SQL for queries with additional streams', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'frontend',
          selector: '{app="frontend"}'
        },
        rightStream: {
          source: 'backend',
          selector: '{app="backend"}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id'],
        additionalStreams: [
          {
            source: 'database',
            selector: '{service="db"}'
          },
          {
            source: 'cache',
            selector: '{service="redis"}'
          }
        ]
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('left_stream AS');
      expect(sql).toContain('right_stream AS');
      expect(sql).toContain('stream_3 AS');
      expect(sql).toContain('stream_4 AS');
      expect(sql).toContain("source = 'database'");
      expect(sql).toContain("source = 'cache'");
    });

    it('should handle multi-stream correlation using generateMultiStreamSQL', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'app1',
          selector: '{}'
        },
        rightStream: {
          source: 'app2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['trace_id'],
        additionalStreams: [
          {
            source: 'app3',
            selector: '{service="app3"}'
          }
        ]
      };

      const sql = generator.generateMultiStreamSQL(query);
      expect(sql).toContain('stream_3 AS');
    });
  });

  describe('CTE Generation', () => {
    it('should generate proper CTE structure', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'logs',
          selector: '{level="info"}',
          timeRange: '1h'
        },
        rightStream: {
          source: 'metrics',
          selector: '{type="counter"}',
          timeRange: '1h'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['service_name']
      };

      const sql = generator.generateSQL(query);
      
      expect(sql).toMatch(/WITH\s+left_stream AS \(/);
      expect(sql).toMatch(/,\s+right_stream AS \(/);
      expect(sql).toContain("'left_stream' as stream_side");
      expect(sql).toContain("'right_stream' as stream_side");
      expect(sql).toContain('SELECT');
      expect(sql).toContain('FROM events');
    });

    it('should include sampling for approximate queries', () => {
      const options: SQLGeneratorOptions = {
        useApproximate: true,
        samplePercent: 25
      };
      
      generator = new TimeQLToSQLGenerator(options);
      
      const query: ParsedQuery = {
        leftStream: {
          source: 'large_dataset',
          selector: '{}'
        },
        rightStream: {
          source: 'another_large_dataset',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('USING SAMPLE 25%');
    });
  });

  describe('EXPLAIN Query Generation', () => {
    it('should generate EXPLAIN query for performance analysis', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'app',
          selector: '{level="error"}'
        },
        rightStream: {
          source: 'infra',
          selector: '{alert="true"}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['incident_id']
      };

      const explainSQL = generator.generateExplainSQL(query);
      expect(explainSQL.startsWith('EXPLAIN ANALYZE')).toBe(true);
      expect(explainSQL).toContain('WITH');
      expect(explainSQL).toContain('INNER JOIN');
    });
  });

  describe('Statistics Query Generation', () => {
    it('should generate statistics SQL for query optimization', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'application_logs',
          selector: '{service="api"}',
          timeRange: '24h'
        },
        rightStream: {
          source: 'error_logs',
          selector: '{level="error"}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['request_id']
      };

      const statsSQL = generator.generateStatsSQL(query);
      expect(statsSQL).toContain('COUNT(DISTINCT l.request_id) as unique_keys');
      expect(statsSQL).toContain('COUNT(*) as total_events');
      expect(statsSQL).toContain('MIN(l.timestamp) as min_timestamp');
      expect(statsSQL).toContain('MAX(l.timestamp) as max_timestamp');
      expect(statsSQL).toContain("l.source = 'application_logs'");
      expect(statsSQL).toContain("INTERVAL '24 hours'");
    });

    it('should generate stats SQL without time window when not specified', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'all_logs',
          selector: '{}'
        },
        rightStream: {
          source: 'events',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const statsSQL = generator.generateStatsSQL(query);
      expect(statsSQL).not.toContain('INTERVAL');
      expect(statsSQL).toContain('COUNT(DISTINCT l.request_id)');
    });
  });

  describe('Configuration Options', () => {
    it('should use custom table name', () => {
      const options: SQLGeneratorOptions = {
        tableName: 'custom_events_table'
      };
      
      generator = new TimeQLToSQLGenerator(options);
      
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}'
        },
        rightStream: {
          source: 'test2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('FROM custom_events_table');
    });

    it('should apply limit when specified', () => {
      const options: SQLGeneratorOptions = {
        limit: 1000
      };
      
      generator = new TimeQLToSQLGenerator(options);
      
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}'
        },
        rightStream: {
          source: 'test2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql.endsWith('\nLIMIT 1000')).toBe(true);
    });

    it('should not apply limit when not specified', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test',
          selector: '{}'
        },
        rightStream: {
          source: 'test2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).not.toContain('LIMIT');
    });
  });

  describe('Complex Join Scenarios', () => {
    it('should handle multiple join keys', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'orders',
          selector: '{type="order"}'
        },
        rightStream: {
          source: 'payments',
          selector: '{type="payment"}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['user_id', 'order_id']
      };

      const sql = generator.generateSQL(query);
      // Note: Current implementation only uses first join key
      // This test documents current behavior
      expect(sql).toContain("'user_id' as join_key");
      expect(sql).toContain('l.user_id = r.user_id');
    });

    it('should generate correlation metadata in SELECT', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'source1',
          selector: '{}'
        },
        rightStream: {
          source: 'source2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['correlation_id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('gen_random_uuid() as correlation_id');
      expect(sql).toContain('l.timestamp as left_timestamp');
      expect(sql).toContain('r.timestamp as right_timestamp');
      expect(sql).toContain('l.message as left_message');
      expect(sql).toContain('r.message as right_message');
      expect(sql).toContain('l.source as left_source');
      expect(sql).toContain('r.source as right_source');
      expect(sql).toContain('l.labels as left_labels');
      expect(sql).toContain('r.labels as right_labels');
      expect(sql).toContain('LEAST(l.timestamp, r.timestamp) as window_start');
      expect(sql).toContain('GREATEST(l.timestamp, r.timestamp) as window_end');
    });

    it('should handle queries with only left stream (single stream query)', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'single_source',
          selector: '{level="error"}',
          timeRange: '1h'
        },
        rightStream: {
          source: '',
          selector: ''
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('left_stream AS');
      // Should still generate valid SQL even with empty right stream
      expect(sql).toContain("source = 'single_source'");
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle queries with special characters in source names', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'app-with-dashes',
          selector: '{}'
        },
        rightStream: {
          source: 'app_with_underscores',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id']
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain("source = 'app-with-dashes'");
      expect(sql).toContain("source = 'app_with_underscores'");
    });

    it('should handle empty join keys array', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test1',
          selector: '{}'
        },
        rightStream: {
          source: 'test2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: []
      };

      const sql = generator.generateSQL(query);
      // Should still generate SQL, might use default join behavior
      expect(sql).toContain('INNER JOIN');
    });

    it('should handle queries with undefined fields gracefully', () => {
      const query: ParsedQuery = {
        leftStream: {
          source: 'test1',
          selector: '{}'
        },
        rightStream: {
          source: 'test2',
          selector: '{}'
        },
        joinType: 'and' as JoinType,
        joinKeys: ['id'],
        temporal: undefined,
        timeWindow: undefined
      };

      const sql = generator.generateSQL(query);
      expect(sql).toContain('INNER JOIN');
      expect(sql).not.toContain('BETWEEN');
    });
  });
});