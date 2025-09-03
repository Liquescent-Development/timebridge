/**
 * SQL Builder for TimeQL to DuckDB SQL translation
 * Uses structured approach instead of string concatenation
 */

import { ParsedQuery } from './types';

export interface SQLQuery {
  with?: CTEDefinition[];
  select: SelectClause;
  from: FromClause;
  join?: JoinClause;
  where?: WhereClause;
  orderBy?: OrderByClause;
}

export interface CTEDefinition {
  name: string;
  query: {
    select: SelectClause;
    from: FromClause;
    where?: WhereClause;
  };
}

export interface SelectClause {
  items: SelectItem[];
}

export interface SelectItem {
  expression: string;
  alias?: string;
}

export interface FromClause {
  table: string;
  alias?: string;
}

export interface JoinClause {
  type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL OUTER';
  table: string;
  alias?: string;
  on: JoinCondition[];
}

export interface JoinCondition {
  left: string;
  right: string;
}

export interface WhereClause {
  conditions: WhereCondition[];
}

export interface WhereCondition {
  type: 'comparison' | 'between' | 'in' | 'exists' | 'not_exists';
  expression: string;
}

export interface OrderByClause {
  items: OrderByItem[];
}

export interface OrderByItem {
  expression: string;
  direction?: 'ASC' | 'DESC';
}

export class SQLBuilder {
  /**
   * Build SQL query from parsed TimeQL
   */
  buildCorrelationQuery(query: ParsedQuery): SQLQuery {
    const joinField = query.joinKeys?.[0] || 'request_id';
    const leftSource = this.extractSource(query.leftStream.source);
    const rightSource = query.rightStream ? this.extractSource(query.rightStream.source) : null;
    
    // Build CTEs for left and right streams
    const ctes: CTEDefinition[] = [];
    
    // Left stream CTE
    ctes.push({
      name: 'left_stream',
      query: {
        select: {
          items: [
            { expression: '*' },
            { expression: "'left_stream'", alias: 'stream_side' }
          ]
        },
        from: { table: 'events' },
        where: {
          conditions: [
            { type: 'comparison', expression: `source = '${leftSource}'` },
            { type: 'comparison', expression: `stream = 'left_stream'` },
            { type: 'comparison', expression: `timestamp >= CURRENT_TIMESTAMP - INTERVAL '${query.leftStream.timeRange}'` },
            { type: 'comparison', expression: `timestamp <= CURRENT_TIMESTAMP` }
          ]
        }
      }
    });
    
    // Right stream CTE (if exists)
    if (query.rightStream && rightSource) {
      ctes.push({
        name: 'right_stream',
        query: {
          select: {
            items: [
              { expression: '*' },
              { expression: "'right_stream'", alias: 'stream_side' }
            ]
          },
          from: { table: 'events' },
          where: {
            conditions: [
              { type: 'comparison', expression: `source = '${rightSource}'` },
              { type: 'comparison', expression: `stream = 'right_stream'` },
              { type: 'comparison', expression: `timestamp >= CURRENT_TIMESTAMP - INTERVAL '${query.rightStream.timeRange}'` },
              { type: 'comparison', expression: `timestamp <= CURRENT_TIMESTAMP` }
            ]
          }
        }
      });
    }
    
    // Build main query
    const mainQuery: SQLQuery = {
      with: ctes,
      select: {
        items: [
          { expression: this.getJoinFieldExpression(joinField, 'l'), alias: 'correlation_id' },
          { expression: `'${joinField}'`, alias: 'join_key' },
          { expression: this.getJoinFieldExpression(joinField, 'l'), alias: 'join_value' },
          { expression: 'l.timestamp', alias: 'left_timestamp' },
          { expression: 'r.timestamp', alias: 'right_timestamp' },
          { expression: 'l.message', alias: 'left_message' },
          { expression: 'r.message', alias: 'right_message' },
          { expression: 'l.source', alias: 'left_source' },
          { expression: 'r.source', alias: 'right_source' },
          { expression: 'l.labels', alias: 'left_labels' },
          { expression: 'r.labels', alias: 'right_labels' },
          { expression: 'LEAST(l.timestamp, r.timestamp)', alias: 'window_start' },
          { expression: 'GREATEST(l.timestamp, r.timestamp)', alias: 'window_end' }
        ]
      },
      from: {
        table: 'left_stream',
        alias: 'l'
      },
      orderBy: {
        items: [{ expression: 'l.timestamp' }]
      }
    };
    
    // Add JOIN clause if right stream exists
    if (query.rightStream) {
      const joinType = this.mapJoinType(query.joinType);
      
      if (joinType === 'ANTI') {
        // Handle anti-join with NOT EXISTS
        mainQuery.where = {
          conditions: [{
            type: 'not_exists',
            expression: this.buildAntiJoinSubquery(joinField, query.temporal)
          }]
        };
      } else {
        // Regular join
        mainQuery.join = {
          type: joinType as 'INNER' | 'LEFT' | 'RIGHT',
          table: 'right_stream',
          alias: 'r',
          on: [{
            left: this.getJoinFieldExpression(joinField, 'l'),
            right: this.getJoinFieldExpression(joinField, 'r')
          }]
        };
        
        // Add temporal conditions if specified
        if (query.temporal) {
          const temporalWindow = this.parseTimeWindow(query.temporal);
          mainQuery.join.on.push({
            left: 'r.timestamp',
            right: `l.timestamp - INTERVAL '${temporalWindow}' AND l.timestamp + INTERVAL '${temporalWindow}'`
          });
        }
      }
    }
    
    return mainQuery;
  }
  
  /**
   * Convert SQLQuery to SQL string
   */
  toSQL(query: SQLQuery): string {
    let sql = '';
    
    // Add CTEs
    if (query.with && query.with.length > 0) {
      sql += 'WITH\n';
      sql += query.with.map(cte => this.buildCTE(cte)).join(',\n');
      sql += '\n';
    }
    
    // Add SELECT
    sql += 'SELECT\n';
    sql += query.select.items.map(item => {
      const expr = item.alias ? `${item.expression} as ${item.alias}` : item.expression;
      return `  ${expr}`;
    }).join(',\n');
    sql += '\n';
    
    // Add FROM
    sql += 'FROM ';
    sql += query.from.alias ? `${query.from.table} ${query.from.alias}` : query.from.table;
    sql += '\n';
    
    // Add JOIN
    if (query.join) {
      sql += `${query.join.type} JOIN `;
      sql += query.join.alias ? `${query.join.table} ${query.join.alias}` : query.join.table;
      sql += '\n';
      sql += '  ON ';
      sql += query.join.on.map(cond => `${cond.left} = ${cond.right}`).join('\n  AND ');
      sql += '\n';
    }
    
    // Add WHERE
    if (query.where) {
      sql += 'WHERE ';
      sql += query.where.conditions.map(cond => cond.expression).join('\n  AND ');
      sql += '\n';
    }
    
    // Add ORDER BY
    if (query.orderBy) {
      sql += 'ORDER BY ';
      sql += query.orderBy.items.map(item => {
        return item.direction ? `${item.expression} ${item.direction}` : item.expression;
      }).join(', ');
    }
    
    return sql;
  }
  
  private buildCTE(cte: CTEDefinition): string {
    let sql = `${cte.name} AS (\n`;
    
    // SELECT
    sql += '  SELECT \n';
    sql += cte.query.select.items.map(item => {
      const expr = item.alias ? `${item.expression} as ${item.alias}` : item.expression;
      return `    ${expr}`;
    }).join(',\n');
    sql += '\n';
    
    // FROM
    sql += `  FROM ${cte.query.from.table}\n`;
    
    // WHERE
    if (cte.query.where) {
      sql += '  WHERE ';
      sql += cte.query.where.conditions.map((cond, i) => {
        const prefix = i === 0 ? '' : '    AND ';
        return `${prefix}${cond.expression}`;
      }).join('\n');
      sql += '\n';
    }
    
    sql += ')';
    return sql;
  }
  
  private extractSource(source: string): string {
    // Extract the actual source name without stream specifier
    // e.g., "graylog-ap-northeast-1:stream-name" -> "graylog-ap-northeast-1"
    const colonIndex = source.indexOf(':');
    return colonIndex > -1 ? source.substring(0, colonIndex) : source;
  }
  
  private getJoinFieldExpression(field: string, alias: string): string {
    // Use dedicated column for request_id, JSON extraction for others
    if (field === 'request_id') {
      return `${alias}.${field}`;
    } else {
      return `json_extract_string(${alias}.labels, '$.${field}')`;
    }
  }
  
  private mapJoinType(joinType: string): string {
    switch (joinType) {
      case 'and': return 'INNER';
      case 'or': return 'LEFT';
      case 'unless': return 'ANTI';
      default: return 'INNER';
    }
  }
  
  private parseTimeWindow(window: string): string {
    // Convert time window format (e.g., "5m", "1h", "7d") to SQL interval
    const match = window.match(/^(\d+)([smhd])$/);
    if (!match) return '5 minutes';
    
    const [, value, unit] = match;
    const unitMap: Record<string, string> = {
      's': 'seconds',
      'm': 'minutes',
      'h': 'hours',
      'd': 'days'
    };
    
    return `${value} ${unitMap[unit] || 'minutes'}`;
  }
  
  private buildAntiJoinSubquery(joinField: string, temporal?: string): string {
    let sql = `NOT EXISTS (\n`;
    sql += `  SELECT 1 FROM right_stream r\n`;
    sql += `  WHERE ${this.getJoinFieldExpression(joinField, 'l')} = ${this.getJoinFieldExpression(joinField, 'r')}`;
    
    if (temporal) {
      const temporalWindow = this.parseTimeWindow(temporal);
      sql += `\n    AND r.timestamp BETWEEN l.timestamp - INTERVAL '${temporalWindow}'`;
      sql += `\n                         AND l.timestamp + INTERVAL '${temporalWindow}'`;
    }
    
    sql += '\n)';
    return sql;
  }
}