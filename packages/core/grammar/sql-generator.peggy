// SQL Generator Grammar for TimeQL to DuckDB SQL translation
// This grammar generates SQL from parsed TimeQL queries
// It ensures proper SQL syntax and handles all edge cases consistently

// ============================================================================
// Entry Point - Generate complete SQL query from TimeQL AST
// ============================================================================

{
  // Helper function to escape SQL strings
  function escapeSQL(str) {
    return str ? str.replace(/'/g, "''") : '';
  }
  
  // Helper to extract join field expression
  function getJoinExpression(field, alias) {
    if (field === 'request_id') {
      return `${alias}.${field}`;
    } else {
      return `json_extract_string(${alias}.labels, '$.${field}')`;
    }
  }
}

Query = CTEQuery / SimpleQuery

// ============================================================================
// CTE-based correlation query (main pattern)
// ============================================================================

CTEQuery = "WITH" _ ctes:CTEList _ main:MainQuery {
  return `WITH\n${ctes}\n${main}`;
}

CTEList = first:CTE rest:(_ "," _ CTE)* {
  const ctes = [first];
  if (rest) {
    ctes.push(...rest.map(r => r[3]));
  }
  return ctes.join(',\n');
}

CTE = name:Identifier _ "AS" _ "(" _ query:CTESelect _ ")" {
  return `${name} AS (\n${query}\n)`;
}

CTESelect = "SELECT" _ fields:SelectList _ "FROM" _ table:TableName _ where:WhereClause? {
  let sql = `  SELECT \n${fields}\n  FROM ${table}`;
  if (where) {
    sql += `\n  WHERE ${where}`;
  }
  return sql;
}

// ============================================================================
// Main query with JOIN
// ============================================================================

MainQuery = "SELECT" _ fields:SelectList _ "FROM" _ from:TableRef _ join:JoinClause? _ where:WhereClause? _ order:OrderByClause? {
  let sql = `SELECT\n${fields}\nFROM ${from}`;
  if (join) {
    sql += `\n${join}`;
  }
  if (where) {
    sql += `\nWHERE ${where}`;
  }
  if (order) {
    sql += `\n${order}`;
  }
  return sql;
}

// ============================================================================
// SELECT components
// ============================================================================

SelectList = first:SelectItem rest:(_ "," _ SelectItem)* {
  const items = [first];
  if (rest) {
    items.push(...rest.map(r => r[3]));
  }
  return items.map(item => `  ${item}`).join(',\n');
}

SelectItem = expr:Expression _ ("AS" / "as") _ alias:Identifier {
    return `${expr} as ${alias}`;
  }
  / expr:Expression {
    return expr;
  }

Expression = FunctionCall / ColumnRef / Literal / Wildcard

FunctionCall = name:FunctionName _ "(" _ args:ArgumentList? _ ")" {
  return `${name}(${args || ''})`;
}

FunctionName = "LEAST"i / "GREATEST"i / "json_extract_string"i / "COUNT"i / "SUM"i / "AVG"i / "MAX"i / "MIN"i {
  return text().toUpperCase();
}

ArgumentList = first:Expression rest:(_ "," _ Expression)* {
  const args = [first];
  if (rest) {
    args.push(...rest.map(r => r[3]));
  }
  return args.join(', ');
}

ColumnRef = table:Identifier "." column:Identifier {
    return `${table}.${column}`;
  }
  / column:Identifier {
    return column;
  }

Wildcard = "*" {
  return "*";
}

// ============================================================================
// JOIN components
// ============================================================================

JoinClause = type:JoinType _ table:TableRef _ "ON" _ condition:JoinCondition {
  return `${type} ${table}\n  ON ${condition}`;
}

JoinType = ("INNER" _ "JOIN") { return "INNER JOIN"; }
  / ("LEFT" _ "JOIN") { return "LEFT JOIN"; }
  / ("RIGHT" _ "JOIN") { return "RIGHT JOIN"; }
  / ("FULL" _ "OUTER" _ "JOIN") { return "FULL OUTER JOIN"; }

JoinCondition = left:Expression _ "=" _ right:Expression _ and:("AND" _ JoinCondition)? {
  let condition = `${left} = ${right}`;
  if (and) {
    condition += `\n  AND ${and[2]}`;
  }
  return condition;
}

// ============================================================================
// WHERE clause
// ============================================================================

WhereClause = conditions:ConditionList {
  return conditions;
}

ConditionList = first:Condition rest:(_ "AND" _ Condition)* {
  const conditions = [first];
  if (rest) {
    conditions.push(...rest.map(r => r[3]));
  }
  return conditions.join('\n    AND ');
}

Condition = ComparisonCondition / BetweenCondition / InCondition / NotExistsCondition

ComparisonCondition = left:Expression _ op:ComparisonOp _ right:Expression {
  return `${left} ${op} ${right}`;
}

ComparisonOp = ">=" / "<=" / "=" / "!=" / "<>" / ">" / "<"

BetweenCondition = expr:Expression _ "BETWEEN"i _ low:Expression _ "AND"i _ high:Expression {
  return `${expr} BETWEEN ${low} AND ${high}`;
}

InCondition = expr:Expression _ "IN"i _ "(" _ values:ValueList _ ")" {
  return `${expr} IN (${values})`;
}

ValueList = first:Literal rest:(_ "," _ Literal)* {
  const values = [first];
  if (rest) {
    values.push(...rest.map(r => r[3]));
  }
  return values.join(', ');
}

NotExistsCondition = "NOT"i _ "EXISTS"i _ "(" _ subquery:SubQuery _ ")" {
  return `NOT EXISTS (\n${subquery}\n)`;
}

SubQuery = _ "SELECT" _ fields:SelectList _ "FROM" _ table:TableRef _ where:WhereClause? {
  let sql = `  SELECT ${fields}\n  FROM ${table}`;
  if (where) {
    sql += `\n  WHERE ${where}`;
  }
  return sql;
}

// ============================================================================
// ORDER BY clause
// ============================================================================

OrderByClause = "ORDER"i _ "BY"i _ items:OrderByList {
  return `ORDER BY ${items}`;
}

OrderByList = first:OrderByItem rest:(_ "," _ OrderByItem)* {
  const items = [first];
  if (rest) {
    items.push(...rest.map(r => r[3]));
  }
  return items.join(', ');
}

OrderByItem = expr:Expression _ dir:SortDirection? {
  return dir ? `${expr} ${dir}` : expr;
}

SortDirection = "ASC"i { return "ASC"; }
  / "DESC"i { return "DESC"; }

// ============================================================================
// Basic components
// ============================================================================

TableRef = name:Identifier _ alias:("AS"i _ Identifier)? {
  return alias ? `${name} ${alias[1]}` : name;
}

TableName = Identifier

Identifier = [a-zA-Z_][a-zA-Z0-9_]* { return text(); }

Literal = StringLiteral / NumberLiteral / IntervalLiteral / NullLiteral

StringLiteral = "'" chars:([^'])* "'" {
  return `'${chars.join('')}'`;
}

NumberLiteral = [0-9]+ ("." [0-9]+)? {
  return text();
}

IntervalLiteral = "INTERVAL"i _ "'" _ value:IntervalValue _ "'" {
  return `INTERVAL '${value}'`;
}

IntervalValue = [0-9]+ _ unit:TimeUnit {
  return text();
}

TimeUnit = "days"i / "hours"i / "minutes"i / "seconds"i / "day"i / "hour"i / "minute"i / "second"i

NullLiteral = "NULL"i { return "NULL"; }

// ============================================================================
// Whitespace
// ============================================================================

_ = [ \t\n\r]*

// ============================================================================
// Simple query pattern (for testing)
// ============================================================================

SimpleQuery = "SELECT" _ "*" _ "FROM" _ table:TableName {
  return `SELECT * FROM ${table}`;
}