import { ParsedQuery, StreamQuery } from './types';
import { SQLBuilder } from './sql-builder';

export interface SQLGeneratorOptions {
  /**
   * The table name to query from
   */
  tableName?: string;
  
  /**
   * Whether to use approximate algorithms for large datasets
   */
  useApproximate?: boolean;
  
  /**
   * Sample percentage for approximate queries (0-100)
   */
  samplePercent?: number;
  
  /**
   * Maximum number of results to return
   */
  limit?: number;
  
  /**
   * Partitions to prune from the query
   */
  prunedPartitions?: string[];
  
  /**
   * List of fields that have dedicated columns in DuckDB
   * TODO: This should be dynamically determined from the DuckDB schema
   * or better yet, we should create columns on-demand based on join keys
   */
  dedicatedColumns?: string[];
  
  /**
   * Whether to use predicate pushdown
   */
  enablePredicatePushdown?: boolean;
  
  /**
   * Suggested join order for optimization
   */
  optimizedJoinOrder?: string[];
}

/**
 * Generates SQL from parsed TimeQL queries
 */
export class TimeQLToSQLGenerator {
  private options: SQLGeneratorOptions;
  private sqlBuilder: SQLBuilder;

  constructor(options: SQLGeneratorOptions = {}) {
    this.options = {
      tableName: options.tableName || 'events',
      useApproximate: options.useApproximate || false,
      samplePercent: options.samplePercent || 10,
      limit: options.limit,
    };
    this.sqlBuilder = new SQLBuilder();
  }

  /**
   * Generate SQL from a parsed TimeQL query
   */
  generateSQL(query: ParsedQuery): string {
    // Handle different query types
    if (query.type === 'aggregation') {
      return this.generateAggregationSQL(query);
    } else if (query.type === 'database') {
      return this.generateDatabaseSQL(query);
    } else if (query.type === 'pattern') {
      return this.generatePatternSQL(query);
    } else {
      // Use the existing SQLBuilder for correlation queries
      const sqlQuery = this.sqlBuilder.buildCorrelationQuery(query);
      const sql = this.sqlBuilder.toSQL(sqlQuery);
      
      // Add LIMIT if specified
      if (this.options.limit) {
        return sql + `\nLIMIT ${this.options.limit}`;
      }
      
      return sql;
    }
  }
  
  /**
   * Generate SQL for database queries (events{...}[...])
   */
  private generateDatabaseSQL(query: ParsedQuery): string {
    const stream = query.leftStream;  // For direct queries, we use leftStream
    let sql = `SELECT * FROM ${this.options.tableName}`;
    const conditions = [];
    
    // Add time range filter
    if (stream.timeRange) {
      const timeWindow = this.parseTimeWindow(stream.timeRange);
      if (timeWindow) {
        conditions.push(`timestamp >= CURRENT_TIMESTAMP - INTERVAL '${timeWindow}'`);
      }
    }
    
    // Parse label selectors if present
    if (stream.selectorParsed?.matchers) {
      for (const matcher of stream.selectorParsed.matchers) {
        const field = `json_extract_string(labels, '$.${matcher.label}')`;
        const value = matcher.value;
        
        switch(matcher.op) {
          case '=':
            conditions.push(`${field} = '${value}'`);
            break;
          case '!=':
            conditions.push(`${field} != '${value}'`);
            break;
          case '=~':
            conditions.push(`regexp_matches(${field}, '${value}')`);
            break;
          case '!~':
            conditions.push(`NOT regexp_matches(${field}, '${value}')`);
            break;
        }
      }
    }
    
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    // Add LIMIT if specified
    if (this.options.limit) {
      sql += ` LIMIT ${this.options.limit}`;
    }
    
    return sql;
  }
  
  /**
   * Generate SQL for aggregation queries
   */
  private generateAggregationSQL(query: ParsedQuery): string {
    // First generate SQL for the inner query
    const innerSQL = query.query ? this.generateSQL(query.query) : 'SELECT * FROM events';
    
    // Build aggregation SQL
    const func = query.function || 'count';
    const groupBy = query.groupBy || [];
    
    let sql = 'WITH inner_query AS (\n';
    sql += `  ${innerSQL.replace(/\n/g, '\n  ')}\n`;
    sql += ')\n';
    
    // Build SELECT clause based on aggregation function
    const selectClauses = [];
    
    // Add group by columns
    for (const col of groupBy) {
      selectClauses.push(`json_extract_string(labels, '$.${col}') as ${col}`);
    }
    
    // Add aggregation
    switch(func) {
      case 'sum':
        selectClauses.push('SUM(value) as sum');
        break;
      case 'avg':
        selectClauses.push('AVG(value) as avg');
        break;
      case 'count':
        selectClauses.push('COUNT(*) as count');
        break;
      case 'min':
        selectClauses.push('MIN(value) as min');
        break;
      case 'max':
        selectClauses.push('MAX(value) as max');
        break;
      case 'rate':
        // Rate calculation (events per second)
        selectClauses.push('COUNT(*) / (MAX(timestamp) - MIN(timestamp)) as rate');
        break;
      default:
        selectClauses.push('COUNT(*) as count');
    }
    
    sql += `SELECT ${selectClauses.join(', ')}\n`;
    sql += 'FROM inner_query';
    
    if (groupBy.length > 0) {
      sql += '\nGROUP BY ' + groupBy.map((col: string) => `json_extract_string(labels, '$.${col}')`).join(', ');
    }
    
    return sql;
  }

  /**
   * Generate a CTE for a stream
   */
  private generateStreamCTE(cteName: string, stream: any): string {
    const timeWindow = this.parseTimeWindow(stream.timeRange);
    
    let cte = `${cteName} AS (\n`;
    cte += `  SELECT \n`;
    cte += `    *,\n`;
    cte += `    '${cteName}' as stream_side\n`;
    cte += `  FROM ${this.options.tableName}\n`;
    cte += `  WHERE source = '${stream.source}'\n`;
    cte += `    AND stream = '${cteName}'\n`;  // Filter by stream identifier to separate left/right
    
    // Add time window
    if (timeWindow) {
      cte += `    AND timestamp >= CURRENT_TIMESTAMP - INTERVAL '${timeWindow}'\n`;
      cte += `    AND timestamp <= CURRENT_TIMESTAMP\n`;
    }
    
    // IMPORTANT: Do NOT add selector filters here!
    // The data in DuckDB has already been filtered by the source system (Graylog, Loki, etc.)
    // We only need to filter by source, stream, and time window to get the right data.
    // The selector was used to fetch the right data from the source, not to filter in DuckDB.
    
    // Add sampling for approximate queries
    if (this.options.useApproximate) {
      cte += `  USING SAMPLE ${this.options.samplePercent}%\n`;
    }
    
    cte += ')';
    
    return cte;
  }

  /**
   * Generate WHERE clause from native query
   * Supports Graylog, LogQL, and PromQL selector formats
   */
  private generateWhereClause(stream: any): string {
    if (!stream.selector) return '';
    
    const conditions: string[] = [];
    
    // Detect query format and parse accordingly
    if (stream.source === 'loki' || stream.selector.includes('|')) {
      // LogQL format
      conditions.push(...this.parseLogQLSelector(stream.selector));
    } else if (stream.source === 'prometheus' || stream.selector.includes('__name__')) {
      // PromQL format  
      conditions.push(...this.parsePromQLSelector(stream.selector));
    } else {
      // Graylog format (default)
      conditions.push(...this.parseGraylogSelector(stream.selector));
    }
    
    // Add partition pruning if we have optimization hints
    if (this.options.prunedPartitions && this.options.prunedPartitions.length > 0) {
      const partitionList = this.options.prunedPartitions.map(p => `'${p}'`).join(',');
      conditions.push(`partition_date NOT IN (${partitionList})`);
    }
    
    return conditions.join(' AND ');
  }
  
  /**
   * Parse Graylog-style selector using the proper parser
   * NOTE: This is now ONLY used for debugging/logging, not for actual filtering
   * since DuckDB data is already filtered by the source system
   */
  private parseGraylogSelector(selector: string): string[] {
    // No longer needed for SQL generation since we don't filter in DuckDB
    // The selector was already used by Graylog to filter the data
    return [];
  }
  
  /**
   * Convert Graylog AST to SQL conditions
   */
  private astToSQLConditions(node: any): string[] {
    const conditions: string[] = [];
    const dedicatedColumns = this.options.dedicatedColumns || ['request_id', 'trace_id', 'correlation_id', 'session_id', 'user_id', 'account_id'];
    
    switch (node.type) {
      case 'match_all':
        // No conditions - matches everything
        break;
        
      case 'field':
        const field = node.field;
        const value = node.value;
        
        // Check if this is a dedicated column (but not 'source' which should check labels)
        const isDedicatedColumn = dedicatedColumns.includes(field) && field !== 'source';
        
        if (typeof value === 'string') {
          // Direct string value = exact match
          if (isDedicatedColumn) {
            conditions.push(`${field} = '${value}'`);
          } else {
            conditions.push(`json_extract_string(labels, '$.${field}') = '${value}'`);
          }
        } else if (value.type === 'wildcard') {
          const pattern = value.pattern.replace(/\*/g, '%').replace(/\?/g, '_');
          if (isDedicatedColumn) {
            conditions.push(`${field} LIKE '${pattern}'`);
          } else {
            conditions.push(`json_extract_string(labels, '$.${field}') LIKE '${pattern}'`);
          }
        } else if (value.type === 'fuzzy') {
          // Fuzzy search - use LIKE with % wildcards
          const term = value.term;
          if (isDedicatedColumn) {
            conditions.push(`${field} LIKE '%${term}%'`);
          } else {
            conditions.push(`json_extract_string(labels, '$.${field}') LIKE '%${term}%'`);
          }
        } else if (value.type === 'phrase') {
          // Exact phrase match
          if (isDedicatedColumn) {
            conditions.push(`${field} = '${value.value}'`);
          } else {
            conditions.push(`json_extract_string(labels, '$.${field}') = '${value.value}'`);
          }
        } else if (value.type === 'range') {
          // Handle range queries
          const from = value.from;
          const to = value.to;
          if (isDedicatedColumn) {
            conditions.push(`${field} BETWEEN '${from}' AND '${to}'`);
          } else {
            conditions.push(`json_extract_string(labels, '$.${field}') BETWEEN '${from}' AND '${to}'`);
          }
        } else {
          console.warn(`[SQL] Unknown field value type:`, value);
        }
        break;
        
      case 'exists':
        const existsField = node.field;
        if (dedicatedColumns.includes(existsField)) {
          conditions.push(`${existsField} IS NOT NULL`);
        } else {
          conditions.push(`json_extract_string(labels, '$.${existsField}') IS NOT NULL`);
        }
        break;
        
      case 'not':
        const notConditions = this.astToSQLConditions(node.expression);
        if (notConditions.length > 0) {
          conditions.push(`NOT (${notConditions.join(' AND ')})`);
        }
        break;
        
      case 'boolean':
        const operator = node.operator; // AND or OR
        const clauses = node.clauses || [];
        const subConditions = clauses.flatMap((clause: any) => this.astToSQLConditions(clause));
        if (subConditions.length > 0) {
          if (subConditions.length === 1) {
            conditions.push(...subConditions);
          } else {
            conditions.push(`(${subConditions.join(` ${operator} `)})`);
          }
        }
        break;
        
      case 'term':
        // Full-text search in message
        conditions.push(`message LIKE '%${node.value}%'`);
        break;
        
      case 'phrase':
        // Exact phrase match in message
        conditions.push(`message LIKE '%${node.value}%'`);
        break;
        
      case 'wildcard':
        // Wildcard search in message
        const wildcardPattern = node.pattern.replace(/\*/g, '%').replace(/\?/g, '_');
        conditions.push(`message LIKE '${wildcardPattern}'`);
        break;
        
      default:
        console.warn(`[SQL] Unknown AST node type: ${node.type}`);
    }
    
    return conditions;
  }
  
  /**
   * Parse LogQL-style selector
   * Example: {job="nginx", env=~"prod|staging"} |= "error" 
   */
  private parseLogQLSelector(selector: string): string[] {
    const conditions: string[] = [];
    
    // Extract stream selector
    const streamMatch = selector.match(/\{([^}]+)\}/);
    if (streamMatch) {
      const pairs = this.splitSelector(streamMatch[1]);
      
      for (const pair of pairs) {
        let key: string, value: string;
        
        if (pair.includes('=~')) {
          [key, value] = pair.split('=~').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') ~ '${cleanValue}'`);
        } else if (pair.includes('!~')) {
          [key, value] = pair.split('!~').map(s => s.trim()); 
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') !~ '${cleanValue}'`);
        } else if (pair.includes('!=')) {
          [key, value] = pair.split('!=').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') != '${cleanValue}'`);
        } else if (pair.includes('=')) {
          [key, value] = pair.split('=').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') = '${cleanValue}'`);
        }
      }
    }
    
    // Handle line filters (|=, |~, !=, !~)
    if (selector.includes('|')) {
      const filterMatch = selector.match(/\|\s*([=~!]+)\s*"([^"]+)"/);
      if (filterMatch) {
        const [, op, pattern] = filterMatch;
        if (op === '=') {
          conditions.push(`message LIKE '%${pattern}%'`);
        } else if (op === '~') {
          conditions.push(`message ~ '${pattern}'`);
        } else if (op === '!=') {
          conditions.push(`message NOT LIKE '%${pattern}%'`);
        } else if (op === '!~') {
          conditions.push(`message !~ '${pattern}'`);
        }
      }
    }
    
    return conditions;
  }
  
  /**
   * Parse PromQL-style selector
   * Example: http_requests_total{method="GET", status=~"2.."} 
   */
  private parsePromQLSelector(selector: string): string[] {
    const conditions: string[] = [];
    
    // Extract metric name
    const metricMatch = selector.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (metricMatch) {
      conditions.push(`json_extract_string(labels, '$.__name__') = '${metricMatch[1]}'`);
    }
    
    // Extract label matchers
    const labelsMatch = selector.match(/\{([^}]+)\}/);
    if (labelsMatch) {
      const pairs = this.splitSelector(labelsMatch[1]);
      
      for (const pair of pairs) {
        let key: string, value: string;
        
        if (pair.includes('=~')) {
          [key, value] = pair.split('=~').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') ~ '${cleanValue}'`);
        } else if (pair.includes('!~')) {
          [key, value] = pair.split('!~').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') !~ '${cleanValue}'`);
        } else if (pair.includes('!=')) {
          [key, value] = pair.split('!=').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') != '${cleanValue}'`);
        } else if (pair.includes('=')) {
          [key, value] = pair.split('=').map(s => s.trim());
          const cleanValue = value.replace(/^["']|["']$/g, '');
          conditions.push(`json_extract_string(labels, '$.${key}') = '${cleanValue}'`);
        }
      }
    }
    
    return conditions;
  }

  /**
   * Split selector content by commas, respecting quoted values
   */
  private splitSelector(selectorContent: string): string[] {
    const pairs: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    
    for (let i = 0; i < selectorContent.length; i++) {
      const char = selectorContent[i];
      
      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
        current += char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = '';
        current += char;
      } else if (char === ',' && !inQuotes) {
        pairs.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    if (current.trim()) {
      pairs.push(current.trim());
    }
    
    return pairs;
  }

  /**
   * Parse time window string (e.g., "5m", "1h", "7d")
   */
  private parseTimeWindow(timeRange: string | undefined): string | null {
    if (!timeRange) return null;
    
    // Convert shorthand to PostgreSQL interval format
    const match = timeRange.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    
    const [, value, unit] = match;
    const unitMap: Record<string, string> = {
      's': 'seconds',
      'm': 'minutes',
      'h': 'hours',
      'd': 'days',
    };
    
    return `${value} ${unitMap[unit] || 'minutes'}`;
  }

  /**
   * Get SQL join type from TimeQL join type
   */
  private getJoinType(joinType: string): string {
    switch (joinType.toLowerCase()) {
      case 'and':
        return 'INNER JOIN';
      case 'or':
        return 'LEFT JOIN';
      case 'unless':
        return 'ANTI JOIN';
      default:
        return 'INNER JOIN';
    }
  }

  /**
   * Generate the main query with joins
   */
  private generateMainQuery(query: ParsedQuery, joinType: string): string {
    const joinKeys = query.joinKeys || ['request_id'];
    const temporal = query.temporal;
    
    // Determine how to access the join field
    // If it's request_id, use the column directly, otherwise extract from JSON
    const joinField = joinKeys[0];
    const leftJoinExpr = joinField === 'request_id' 
      ? `l.${joinField}` 
      : `json_extract_string(l.labels, '$.${joinField}')`;
    const rightJoinExpr = joinField === 'request_id'
      ? `r.${joinField}`
      : `json_extract_string(r.labels, '$.${joinField}')`;
    
    let sql = 'SELECT\n';
    sql += `  COALESCE(${leftJoinExpr}, 'unmatched-' || l.timestamp) as correlation_id,\n`;  // Use join field value as correlation_id
    sql += `  '${joinField}' as join_key,\n`;
    sql += `  COALESCE(${leftJoinExpr}, 'unmatched') as join_value,\n`;
    sql += '  l.timestamp as left_timestamp,\n';
    sql += '  r.timestamp as right_timestamp,\n';
    sql += '  l.message as left_message,\n';
    sql += '  r.message as right_message,\n';
    sql += '  l.source as left_source,\n';
    sql += '  r.source as right_source,\n';
    sql += '  l.labels as left_labels,\n';
    sql += '  r.labels as right_labels,\n';
    sql += '  COALESCE(LEAST(l.timestamp, r.timestamp), l.timestamp) as window_start,\n';
    sql += '  COALESCE(GREATEST(l.timestamp, r.timestamp), l.timestamp) as window_end\n';
    sql += 'FROM left_stream l\n';
    
    // Handle anti-join (UNLESS)
    if (joinType === 'ANTI JOIN') {
      sql += 'WHERE NOT EXISTS (\n';
      sql += '  SELECT 1 FROM right_stream r\n';
      sql += `  WHERE ${leftJoinExpr} = ${rightJoinExpr}\n`;
      
      if (temporal) {
        const temporalWindow = this.parseTimeWindow(temporal);
        sql += `    AND r.timestamp BETWEEN l.timestamp - INTERVAL '${temporalWindow}'\n`;
        sql += `                         AND l.timestamp + INTERVAL '${temporalWindow}'\n`;
      }
      
      sql += ')';
    } else {
      // Regular join (INNER or LEFT)
      sql += `${joinType} right_stream r\n`;
      sql += `  ON ${leftJoinExpr} = ${rightJoinExpr}\n`;
      
      // Add temporal constraints
      if (temporal) {
        const temporalWindow = this.parseTimeWindow(temporal);
        sql += `  AND r.timestamp BETWEEN l.timestamp - INTERVAL '${temporalWindow}'\n`;
        sql += `                       AND l.timestamp + INTERVAL '${temporalWindow}'\n`;
      }
    }
    
    sql += '\nORDER BY l.timestamp';
    
    return sql;
  }

  /**
   * Generate SQL for multi-stream correlation (3+ streams)
   */
  generateMultiStreamSQL(query: ParsedQuery): string {
    // This would generate more complex SQL with multiple joins
    // For now, keeping it simple
    return this.generateSQL(query);
  }

  /**
   * Generate an EXPLAIN query for debugging
   */
  generateExplainSQL(query: ParsedQuery): string {
    return 'EXPLAIN ANALYZE\n' + this.generateSQL(query);
  }

  /**
   * Generate SQL to get statistics about a query
   */
  generateStatsSQL(query: ParsedQuery): string {
    const leftStream = query.leftStream;
    const rightStream = query.rightStream;
    const timeWindow = this.parseTimeWindow(leftStream.timeRange);
    
    let sql = 'SELECT\n';
    sql += '  COUNT(DISTINCT l.request_id) as unique_keys,\n';
    sql += '  COUNT(*) as total_events,\n';
    sql += '  MIN(l.timestamp) as min_timestamp,\n';
    sql += '  MAX(l.timestamp) as max_timestamp\n';
    sql += `FROM ${this.options.tableName} l\n`;
    sql += `WHERE l.source = '${leftStream.source}'\n`;
    
    if (timeWindow) {
      sql += `  AND l.timestamp >= CURRENT_TIMESTAMP - INTERVAL '${timeWindow}'\n`;
    }
    
    return sql;
  }

  /**
   * Generate SQL for pattern matching queries
   * Uses LAG/LEAD window functions to detect event sequences
   */
  private generatePatternSQL(query: ParsedQuery): string {
    if (!query.sequence) {
      throw new Error('Pattern query must have a sequence');
    }

    const { first, operator, second, constraint } = query.sequence;
    const tableName = this.options.tableName || 'events';

    // Build WHERE conditions for both events
    const firstConditions = this.buildWhereConditions(first);
    const secondConditions = this.buildWhereConditions(second);

    let sql = '';

    switch (operator) {
      case 'follows':
        // Event B follows Event A (A happens before B)
        sql = `
WITH pattern_events AS (
  SELECT 
    *,
    CASE 
      WHEN ${firstConditions} THEN 'first'
      WHEN ${secondConditions} THEN 'second'
      ELSE NULL
    END as event_type,
    LAG(CASE WHEN ${firstConditions} THEN timestamp END) OVER (ORDER BY timestamp) as prev_first_timestamp
  FROM ${tableName}
  WHERE (${firstConditions}) OR (${secondConditions})
)
SELECT 
  *
FROM pattern_events
WHERE 
  event_type = 'second' 
  AND prev_first_timestamp IS NOT NULL`;
        break;

      case 'precedes':
        // Event A precedes Event B (A happens before B, same as B follows A)
        sql = `
WITH pattern_events AS (
  SELECT 
    *,
    CASE 
      WHEN ${firstConditions} THEN 'first'
      WHEN ${secondConditions} THEN 'second'
      ELSE NULL
    END as event_type,
    LEAD(CASE WHEN ${secondConditions} THEN timestamp END) OVER (ORDER BY timestamp) as next_second_timestamp
  FROM ${tableName}
  WHERE (${firstConditions}) OR (${secondConditions})
)
SELECT 
  *
FROM pattern_events
WHERE 
  event_type = 'first' 
  AND next_second_timestamp IS NOT NULL`;
        break;

      case 'before':
        // All events A before any event B
        sql = `
SELECT *
FROM ${tableName} a
WHERE ${firstConditions}
  AND EXISTS (
    SELECT 1
    FROM ${tableName} b
    WHERE ${secondConditions}
      AND b.timestamp > a.timestamp
  )`;
        break;

      case 'after':
        // All events A after any event B
        sql = `
SELECT *
FROM ${tableName} a
WHERE ${firstConditions}
  AND EXISTS (
    SELECT 1
    FROM ${tableName} b
    WHERE ${secondConditions}
      AND b.timestamp < a.timestamp
  )`;
        break;
    }

    // Add temporal constraint if specified
    if (constraint && constraint.type === 'within') {
      const duration = constraint.duration;
      if (operator === 'follows' || operator === 'precedes') {
        sql += `
  AND ABS(EXTRACT(EPOCH FROM (timestamp - prev_first_timestamp))) <= ${this.parseDurationToSeconds(duration)}`;
      }
    }

    // Add LIMIT if specified
    if (this.options.limit) {
      sql += `
LIMIT ${this.options.limit}`;
    }

    return sql.trim();
  }

  /**
   * Parse duration string to seconds
   */
  private parseDurationToSeconds(duration: string): number {
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(`Invalid duration: ${duration}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: throw new Error(`Invalid duration unit: ${unit}`);
    }
  }

  /**
   * Build WHERE conditions from a StreamQuery
   */
  private buildWhereConditions(stream: StreamQuery): string {
    const conditions: string[] = [];
    
    // Add source filter if specified
    if (stream.source && stream.source !== 'events') {
      conditions.push(`source = '${stream.source}'`);
    }

    // Parse and add selector conditions
    if (stream.selector && stream.selector !== '{}') {
      const selectorConditions = this.parseSelectorToSQL(stream.selector);
      if (selectorConditions) {
        conditions.push(selectorConditions);
      }
    }

    // Add time range if specified
    if (stream.timeRange) {
      conditions.push(`timestamp >= CURRENT_TIMESTAMP - INTERVAL '${stream.timeRange}'`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  }

  /**
   * Parse selector string to SQL conditions
   */
  private parseSelectorToSQL(selector: string): string {
    // Remove curly braces
    selector = selector.replace(/^{|}$/g, '').trim();
    if (!selector) return '';

    const conditions: string[] = [];
    // Split by comma (simple parser for now)
    const parts = selector.split(',');

    for (const part of parts) {
      const [key, value] = part.split('=').map(s => s.trim());
      if (key && value) {
        const cleanValue = value.replace(/["']/g, '');
        conditions.push(`json_extract_string(labels, '$.${key}') = '${cleanValue}'`);
      }
    }

    return conditions.join(' AND ');
  }
}