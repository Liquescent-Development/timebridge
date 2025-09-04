# TimeQL Grammar Extensions for DuckDB Queries

## Current State

You already have a Peggy grammar at `/packages/query-parser/grammar/timeql.peggy` that parses:
- Stream expressions with sources, selectors, and time ranges
- Join operations (and, or, unless)
- Join keys and temporal constraints
- Filters and selectors

## Proposed Grammar Extensions

### 1. Direct Database Queries

Add support for querying persisted data without source prefixes:

```peggy
// Existing: source-specific queries
StreamExpr = source:DataSourceName "(" selector:Selector ")" "[" duration:Duration "]"

// New: database table queries (no source prefix = query persisted data)
DatabaseExpr = "events" selector:LabelSelector? "[" duration:Duration "]" {
  return {
    type: 'database',
    table: 'events',
    selector: selector,
    timeRange: duration
  };
}

// Combined
StreamExpr = DatabaseExpr / SourceStreamExpr
```

### 2. Label Selectors (PromQL-style)

Add Prometheus-style label selectors:

```peggy
LabelSelector = "{" _ labels:LabelList? _ "}" {
  return labels || [];
}

LabelList = first:Label rest:(_ "," _ Label)* {
  return [first, ...rest.map(r => r[3])];
}

Label = key:Identifier _ op:LabelOp _ value:LabelValue {
  return { key, op, value };
}

LabelOp = "=" / "!=" / "=~" / "!~"

LabelValue = StringLiteral / RegexLiteral
```

### 3. Aggregation Functions

Add aggregation support:

```peggy
AggregationExpr = func:AggregationFunc _ by:GroupingClause? _ "(" _ expr:Query _ ")" {
  return {
    type: 'aggregation',
    function: func,
    groupBy: by,
    expression: expr
  };
}

AggregationFunc = "sum" / "avg" / "min" / "max" / "count" / "rate" / "increase" / "topk" / "bottomk"

GroupingClause = "by" _ "(" _ labels:IdentifierList _ ")" {
  return labels;
}
```

### 4. Time Functions

Add time-based analysis functions:

```peggy
TimeFunction = 
  / "rate" "(" expr:Query "[" window:Duration "]" ")" {
      return { type: 'rate', expr, window };
    }
  / "increase" "(" expr:Query "[" window:Duration "]" ")" {
      return { type: 'increase', expr, window };
    }
  / "delta" "(" expr:Query "[" window:Duration "]" ")" {
      return { type: 'delta', expr, window };
    }
```

### 5. Pattern Matching

Add support for event sequence patterns:

```peggy
PatternExpr = expr1:StreamExpr _ op:PatternOp _ "on" "(" key:Identifier ")" _ temporal:TemporalConstraint? _ expr2:StreamExpr {
  return {
    type: 'pattern',
    left: expr1,
    right: expr2,
    operator: op,
    joinKey: key,
    temporal: temporal
  };
}

PatternOp = "follows" / "precedes" / "concurrent"

TemporalConstraint = "within" "(" duration:Duration ")" {
  return duration;
}
```

## Complete Example Grammar Structure

```peggy
// Root query - can be correlation, aggregation, or direct
Query = AggregationQuery / CorrelationQuery / DirectQuery / PatternQuery

// Aggregation queries
AggregationQuery = func:AggregationFunc by:GroupingClause? "(" query:Query ")" {
  return {
    type: 'aggregation',
    function: func,
    groupBy: by,
    query: query
  };
}

// Direct database queries
DirectQuery = expr:DatabaseExpr {
  return {
    type: 'direct',
    source: 'database',
    expression: expr
  };
}

// Database expression
DatabaseExpr = "events" selector:LabelSelector? timeRange:TimeRange? {
  return {
    table: 'events',
    selector: selector,
    timeRange: timeRange || '1h'
  };
}

// Pattern matching queries
PatternQuery = first:StreamExpr patterns:PatternChain+ {
  return {
    type: 'pattern',
    initial: first,
    patterns: patterns
  };
}
```

## Implementation Steps

### 1. Extend the Parser

```javascript
// packages/query-parser/src/index.ts
export class TimeQLParser {
  private parser: any;
  
  constructor() {
    // Load the extended grammar
    this.parser = require('./generated/parser');
  }
  
  parse(query: string): ParsedQuery {
    const ast = this.parser.parse(query);
    
    // Handle different query types
    switch(ast.type) {
      case 'database':
        return this.parseDatabaseQuery(ast);
      case 'aggregation':
        return this.parseAggregationQuery(ast);
      case 'pattern':
        return this.parsePatternQuery(ast);
      default:
        return this.parseCorrelationQuery(ast);
    }
  }
  
  private parseDatabaseQuery(ast: any): ParsedQuery {
    return {
      type: 'database',
      table: ast.table,
      filters: this.parseSelector(ast.selector),
      timeRange: ast.timeRange
    };
  }
}
```

### 2. Generate Parser

```bash
# Build the parser from grammar
cd packages/query-parser
npm run generate-parser  # Runs: peggy --format commonjs -o src/generated/parser.js grammar/timeql.peggy
```

### 3. SQL Generation

```javascript
// packages/core/src/timeql-to-sql.ts
export class TimeQLToSQLGenerator {
  generateSQL(query: ParsedQuery): string {
    switch(query.type) {
      case 'database':
        return this.generateDatabaseSQL(query);
      case 'aggregation':
        return this.generateAggregationSQL(query);
      case 'pattern':
        return this.generatePatternSQL(query);
      default:
        return this.generateCorrelationSQL(query);
    }
  }
  
  private generateDatabaseSQL(query: ParsedQuery): string {
    let sql = `SELECT * FROM ${query.table}`;
    const conditions = [];
    
    // Add time range
    if (query.timeRange) {
      conditions.push(`timestamp >= NOW() - INTERVAL '${query.timeRange}'`);
    }
    
    // Add label filters
    if (query.filters) {
      for (const filter of query.filters) {
        const field = `json_extract_string(labels, '$.${filter.key}')`;
        const value = `'${filter.value}'`;
        
        switch(filter.op) {
          case '=':
            conditions.push(`${field} = ${value}`);
            break;
          case '!=':
            conditions.push(`${field} != ${value}`);
            break;
          case '=~':
            conditions.push(`regexp_matches(${field}, ${value})`);
            break;
        }
      }
    }
    
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    return sql;
  }
}
```

## Benefits of Peggy-based Approach

1. **Type Safety**: Generated parser provides TypeScript types
2. **Error Messages**: Peggy provides detailed parsing errors with line/column info
3. **Performance**: Generated parser is optimized JavaScript
4. **Maintainability**: Grammar is declarative and easy to modify
5. **Testing**: Can test grammar rules independently
6. **Extensibility**: Easy to add new operators and functions

## Example Usage

```javascript
const { TimeQLParser } = require('@timebridge/query-parser');
const { TimeQLToSQLGenerator } = require('@timebridge/core');

const parser = new TimeQLParser();
const generator = new TimeQLToSQLGenerator();

// Parse TimeQL query
const query = parser.parse(`
  sum by(service) (
    rate(events{level="ERROR"}[5m])
  )
`);

// Generate SQL
const sql = generator.generateSQL(query);
console.log(sql);
// Output:
// SELECT 
//   json_extract_string(labels, '$.service') as service,
//   COUNT(*) * 12 as rate_per_minute
// FROM events
// WHERE json_extract_string(labels, '$.level') = 'ERROR'
//   AND timestamp >= NOW() - INTERVAL '5 minutes'
// GROUP BY json_extract_string(labels, '$.service')
```

## Testing the Grammar

```javascript
// packages/query-parser/test/grammar.test.ts
describe('TimeQL Grammar', () => {
  it('should parse database queries', () => {
    const result = parser.parse('events{service="api"}[1h]');
    expect(result.type).toBe('database');
    expect(result.table).toBe('events');
    expect(result.filters).toEqual([
      { key: 'service', op: '=', value: 'api' }
    ]);
    expect(result.timeRange).toBe('1h');
  });
  
  it('should parse aggregation queries', () => {
    const result = parser.parse('sum by(service) (events{level="ERROR"}[1h])');
    expect(result.type).toBe('aggregation');
    expect(result.function).toBe('sum');
    expect(result.groupBy).toEqual(['service']);
  });
});
```

This Peggy-based approach gives you a robust, maintainable parser that can evolve with your query language needs!