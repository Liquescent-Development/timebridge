// InfluxQL Grammar for Peggy
// Based on the official InfluxQL specification
// This grammar validates and parses InfluxQL queries

Query
  = statement:Statement {
      return statement;
    }

Statement
  = SelectStatement
  / ShowStatement
  / CreateStatement
  / AlterStatement
  / DropStatement
  / DeleteStatement

// SELECT Statement
SelectStatement
  = "SELECT"i __ fields:FieldList
    into:IntoClause? __
    "FROM"i __ sources:SourceList
    where:WhereClause?
    groupBy:GroupByClause?
    orderBy:OrderByClause?
    limit:LimitClause?
    offset:OffsetClause?
    slimit:SLimitClause?
    soffset:SOffsetClause?
    tz:TimezoneClause? {
      return {
        type: 'SELECT',
        fields,
        into,
        sources,
        where,
        groupBy,
        orderBy,
        limit,
        offset,
        slimit,
        soffset,
        timezone: tz
      };
    }

// Field List
FieldList
  = first:Field rest:(__ "," __ Field)* {
      return [first, ...rest.map(r => r[3])];
    }

Field
  = "*" {
      return { type: 'wildcard' };
    }
  / func:AggregateFunction __ "(" __ arg:FunctionArgument __ ")" alias:Alias? {
      return { type: 'function', name: func, argument: arg, alias };
    }
  / func:AggregateFunction __ "(" __ arg:FunctionArgument __ "," __ param:Expression __ ")" alias:Alias? {
      return { type: 'function', name: func, argument: arg, parameter: param, alias };
    }
  / expr:FieldExpression alias:Alias? {
      return { type: 'field', expression: expr, alias };
    }

FunctionArgument
  = "*" {
      return { type: 'wildcard' };
    }
  / FieldExpression

FieldExpression
  = MathExpression

MathExpression
  = left:MathTerm __ op:("+" / "-") __ right:MathExpression {
      return { type: 'binary', operator: op, left, right };
    }
  / MathTerm

MathTerm
  = left:MathFactor __ op:("*" / "/" / "%") __ right:MathTerm {
      return { type: 'binary', operator: op, left, right };
    }
  / MathFactor

MathFactor
  = "(" __ expr:MathExpression __ ")" {
      return expr;
    }
  / func:FunctionCall {
      return func;
    }
  / value:Value {
      return value;
    }

FunctionCall
  = "now"i __ "(" __ ")" {
      return { type: 'function', name: 'now' };
    }
  / func:MathFunction __ "(" __ arg:FieldExpression __ ")" {
      return { type: 'function', name: func, arguments: [arg] };
    }
  / func:MathFunction __ "(" __ arg1:FieldExpression __ "," __ arg2:FieldExpression __ ")" {
      return { type: 'function', name: func, arguments: [arg1, arg2] };
    }
  / func:AggregateFunction __ "(" __ arg:FunctionArgument __ ")" {
      return { type: 'function', name: func, arguments: [arg] };
    }
  / func:AggregateFunction __ "(" __ arg:FunctionArgument __ "," __ param:Expression __ ")" {
      return { type: 'function', name: func, arguments: [arg], parameter: param };
    }

MathFunction
  = "ABS"i { return 'ABS'; }
  / "ACOS"i { return 'ACOS'; }
  / "ASIN"i { return 'ASIN'; }
  / "ATAN2"i { return 'ATAN2'; }
  / "ATAN"i { return 'ATAN'; }
  / "CEIL"i { return 'CEIL'; }
  / "COS"i { return 'COS'; }
  / "EXP"i { return 'EXP'; }
  / "FLOOR"i { return 'FLOOR'; }
  / "LOG10"i { return 'LOG10'; }
  / "LOG2"i { return 'LOG2'; }
  / "LOG"i { return 'LOG'; }
  / "LN"i { return 'LN'; }
  / "POW"i { return 'POW'; }
  / "ROUND"i { return 'ROUND'; }
  / "SIN"i { return 'SIN'; }
  / "SQRT"i { return 'SQRT'; }
  / "TAN"i { return 'TAN'; }

Value
  = dur:Duration {
      return { type: 'duration', value: dur };
    }
  / time:TimeLiteral {
      return { type: 'time', value: time };
    }
  / num:Number {
      return { type: 'number', value: num };
    }
  / str:String {
      return { type: 'string', value: str };
    }
  / regex:RegexLiteral {
      return { type: 'regex', pattern: regex };
    }
  / id:Identifier {
      return { type: 'identifier', name: id };
    }

TimeLiteral
  = "'" chars:RFC3339Time "'" {
      return chars;
    }
  / timestamp:TimestampLiteral {
      return timestamp;
    }

RFC3339Time
  = year:[0-9]+ "-" month:[0-9]+ "-" day:[0-9]+ "T" 
    hour:[0-9]+ ":" min:[0-9]+ ":" sec:[0-9]+ 
    frac:("." [0-9]+)? tz:Timezone {
      return year.join('') + '-' + month.join('') + '-' + day.join('') + 
             'T' + hour.join('') + ':' + min.join('') + ':' + sec.join('') + 
             (frac ? frac[0] + frac[1].join('') : '') + tz;
    }

Timezone
  = "Z" { return "Z"; }
  / sign:[+-] hour:[0-9]+ ":" min:[0-9]+ {
      return sign + hour.join('') + ':' + min.join('');
    }

TimestampLiteral
  = digits:[0-9]+ unit:("ms" / "s" / "u" / "µ" / "ns")? {
      return parseInt(digits.join(''), 10) + (unit || '');
    }

// Aggregate Functions (from InfluxQL spec)
AggregateFunction
  = "COUNT"i { return 'COUNT'; }
  / "DISTINCT"i { return 'DISTINCT'; }
  / "INTEGRAL"i { return 'INTEGRAL'; }
  / "MEAN"i { return 'MEAN'; }
  / "MEDIAN"i { return 'MEDIAN'; }
  / "MODE"i { return 'MODE'; }
  / "SPREAD"i { return 'SPREAD'; }
  / "STDDEV"i { return 'STDDEV'; }
  / "SUM"i { return 'SUM'; }
  / "FIRST"i { return 'FIRST'; }
  / "LAST"i { return 'LAST'; }
  / "MAX"i { return 'MAX'; }
  / "MIN"i { return 'MIN'; }
  / "PERCENTILE"i { return 'PERCENTILE'; }
  / "SAMPLE"i { return 'SAMPLE'; }
  / "TOP"i { return 'TOP'; }
  / "BOTTOM"i { return 'BOTTOM'; }
  / "DERIVATIVE"i { return 'DERIVATIVE'; }
  / "DIFFERENCE"i { return 'DIFFERENCE'; }
  / "NON_NEGATIVE_DERIVATIVE"i { return 'NON_NEGATIVE_DERIVATIVE'; }
  / "MOVING_AVERAGE"i { return 'MOVING_AVERAGE'; }
  / "CUMULATIVE_SUM"i { return 'CUMULATIVE_SUM'; }
  / "ELAPSED"i { return 'ELAPSED'; }

// Source List (measurements)
SourceList
  = first:Source rest:(__ "," __ Source)* {
      return [first, ...rest.map(r => r[3])];
    }

Source
  = "(" __ subquery:SelectStatement __ ")" {
      return { type: 'subquery', query: subquery };
    }
  / regex:RegexLiteral {
      return { type: 'regex', pattern: regex };
    }
  / name:Measurement {
      return { type: 'measurement', name };
    }

Measurement
  = policy:Identifier "." measurement:Identifier {
      return { retentionPolicy: policy, measurement };
    }
  / measurement:Identifier {
      return { measurement };
    }

// WHERE Clause
WhereClause
  = __ "WHERE"i __ condition:Condition {
      return condition;
    }

Condition
  = OrCondition

OrCondition
  = left:AndCondition __ "OR"i __ right:OrCondition {
      return { type: 'or', left, right };
    }
  / AndCondition

AndCondition
  = left:NotCondition __ "AND"i __ right:AndCondition {
      return { type: 'and', left, right };
    }
  / NotCondition

NotCondition
  = "NOT"i __ cond:NotCondition {
      return { type: 'not', condition: cond };
    }
  / Comparison

Comparison
  = left:Expression __ op:ComparisonOperator __ right:Expression {
      return { type: 'comparison', operator: op, left, right };
    }
  / left:Expression __ "BETWEEN"i __ lower:Expression __ "AND"i __ upper:Expression {
      return { 
        type: 'between',
        expression: left,
        lower: lower,
        upper: upper
      };
    }
  / left:Expression __ "IN"i __ "(" __ values:ValueList __ ")" {
      return { type: 'in', expression: left, values };
    }
  / left:Expression __ "NOT"i __ "IN"i __ "(" __ values:ValueList __ ")" {
      return { type: 'not_in', expression: left, values };
    }
  / "(" __ cond:Condition __ ")" {
      return cond;
    }

ValueList
  = first:Expression rest:(__ "," __ Expression)* {
      return [first, ...rest.map(r => r[3])];
    }

ComparisonOperator
  = "=~" { return '=~'; }  // regex match
  / "!~" { return '!~'; }  // regex not match
  / "!=" { return '!='; }
  / "<=" { return '<='; }
  / ">=" { return '>='; }
  / "=" { return '='; }
  / "<" { return '<'; }
  / ">" { return '>'; }

Expression
  = MathExpression

// GROUP BY Clause
GroupByClause
  = __ "GROUP"i __ "BY"i __ dimensions:DimensionList fill:FillOption? {
      return { dimensions, fill };
    }

DimensionList
  = first:Dimension rest:(__ "," __ Dimension)* {
      return [first, ...rest.map(r => r[3])];
    }

Dimension
  = "time"i __ "(" __ duration:Duration offset:(__ "," __ Duration)? __ ")" {
      return { type: 'time', interval: duration, offset: offset ? offset[3] : null };
    }
  / "*" {
      return { type: 'wildcard' };
    }
  / tag:Identifier {
      return { type: 'tag', name: tag };
    }

FillOption
  = __ "fill"i __ "(" __ value:FillValue __ ")" {
      return value;
    }

FillValue
  = "null"i { return 'null'; }
  / "none"i { return 'none'; }
  / "previous"i { return 'previous'; }
  / "linear"i { return 'linear'; }
  / num:Number { return num; }

// ORDER BY Clause
OrderByClause
  = __ "ORDER"i __ "BY"i __ sorts:SortList {
      return sorts;
    }

SortList
  = first:Sort rest:(__ "," __ Sort)* {
      return [first, ...rest.map(r => r[3])];
    }

Sort
  = field:Identifier __ dir:SortDirection? {
      return { field, direction: dir || 'ASC' };
    }

SortDirection
  = "ASC"i { return 'ASC'; }
  / "DESC"i { return 'DESC'; }

// LIMIT and OFFSET
LimitClause
  = __ "LIMIT"i __ count:Integer {
      return count;
    }

OffsetClause
  = __ "OFFSET"i __ count:Integer {
      return count;
    }

SLimitClause
  = __ "SLIMIT"i __ count:Integer {
      return count;
    }

SOffsetClause
  = __ "SOFFSET"i __ count:Integer {
      return count;
    }

// Timezone
TimezoneClause
  = __ "tz"i __ "(" __ zone:TimezoneString __ ")" {
      return zone;
    }

TimezoneString
  = '"' chars:TimezoneChar* '"' {
      return chars.join('');
    }
  / "'" chars:SingleQuotedChar* "'" {
      return chars.join('');
    }

TimezoneChar
  = [^"\\]
  / "\\" char:. { return char; }

// Alias
Alias
  = __ "AS"i __ name:Identifier {
      return name;
    }

// INTO Clause
IntoClause
  = __ "INTO"i __ target:IntoTarget {
      return target;
    }

IntoTarget
  = db:Identifier "." rp:QuotedIdentifier "." measurement:Identifier {
      return { type: 'measurement', database: db, retentionPolicy: rp, measurement };
    }
  / db:Identifier "." rp:Identifier "." measurement:Identifier {
      return { type: 'measurement', database: db, retentionPolicy: rp, measurement };
    }
  / policy:Identifier "." ":MEASUREMENT" {
      return { type: 'back_ref', retentionPolicy: policy };
    }
  / ":MEASUREMENT" {
      return { type: 'back_ref' };
    }
  / policy:QuotedIdentifier "." measurement:QuotedIdentifier {
      return { type: 'measurement', retentionPolicy: policy, measurement };
    }
  / policy:Identifier "." measurement:QuotedIdentifier {
      return { type: 'measurement', retentionPolicy: policy, measurement };
    }
  / policy:QuotedIdentifier "." measurement:Identifier {
      return { type: 'measurement', retentionPolicy: policy, measurement };
    }
  / policy:Identifier "." measurement:Identifier {
      return { type: 'measurement', retentionPolicy: policy, measurement };
    }
  / measurement:QuotedIdentifier {
      return { type: 'measurement', measurement };
    }
  / measurement:Identifier {
      return { type: 'measurement', measurement };
    }

// SHOW Statements
ShowStatement
  = ShowMeasurementsStatement
  / ShowTagKeysStatement
  / ShowTagValuesStatement
  / ShowFieldKeysStatement
  / ShowDatabasesStatement
  / ShowRetentionPoliciesStatement
  / ShowSeriesStatement

ShowMeasurementsStatement
  = "SHOW"i __ "MEASUREMENTS"i 
    on:(__ "ON"i __ Identifier)?
    withClause:(__ "WITH"i __ "MEASUREMENT"i __ ComparisonOperator __ Expression)?
    where:WhereClause? 
    limit:LimitClause? {
      return { type: 'SHOW_MEASUREMENTS', on: on?.[3], withClause, where, limit };
    }

ShowTagKeysStatement
  = "SHOW"i __ "TAG"i __ "KEYS"i 
    on:(__ "ON"i __ Identifier)?
    from:FromClause? 
    where:WhereClause? 
    limit:LimitClause? {
      return { type: 'SHOW_TAG_KEYS', on: on?.[3], from, where, limit };
    }

ShowTagValuesStatement
  = "SHOW"i __ "TAG"i __ "VALUES"i from:FromClause? __ "WITH"i __ "KEY"i __ op:("=" / "IN"i) __ key:TagKeyList where:WhereClause? limit:LimitClause? {
      return { type: 'SHOW_TAG_VALUES', from, keyOperator: op, keys: key, where, limit };
    }

ShowFieldKeysStatement
  = "SHOW"i __ "FIELD"i __ "KEYS"i 
    on:(__ "ON"i __ Identifier)?
    from:FromClause? {
      return { type: 'SHOW_FIELD_KEYS', on: on?.[3], from };
    }

ShowDatabasesStatement
  = "SHOW"i __ "DATABASES"i {
      return { type: 'SHOW_DATABASES' };
    }

ShowRetentionPoliciesStatement
  = "SHOW"i __ "RETENTION"i __ "POLICIES"i on:OnClause? {
      return { type: 'SHOW_RETENTION_POLICIES', database: on };
    }

ShowSeriesStatement
  = "SHOW"i __ "SERIES"i from:FromClause? where:WhereClause? limit:LimitClause? offset:OffsetClause? {
      return { type: 'SHOW_SERIES', from, where, limit, offset };
    }

// Helper Clauses
FromClause
  = __ "FROM"i __ source:Source {
      return source;
    }

OnClause
  = __ "ON"i __ database:Identifier {
      return database;
    }

TagKeyList
  = "(" __ keys:IdentifierList __ ")" {
      return keys;
    }
  / key:Identifier {
      return [key];
    }

IdentifierList
  = first:Identifier rest:(__ "," __ Identifier)* {
      return [first, ...rest.map(r => r[3])];
    }

// CREATE Statements
CreateStatement
  = CreateDatabaseStatement
  / CreateRetentionPolicyStatement
  / CreateContinuousQueryStatement

CreateDatabaseStatement
  = "CREATE"i __ "DATABASE"i __ name:Identifier withClause:WithClause? {
      return { type: 'CREATE_DATABASE', name, with: withClause };
    }

CreateRetentionPolicyStatement
  = "CREATE"i __ "RETENTION"i __ "POLICY"i __ name:Identifier __ "ON"i __ database:Identifier 
    duration:RetentionOption replication:RetentionOption? shardDuration:RetentionOption? def:DefaultOption? {
      return { 
        type: 'CREATE_RETENTION_POLICY', 
        name, 
        database, 
        duration, 
        replication, 
        shardDuration,
        default: def 
      };
    }

CreateContinuousQueryStatement
  = "CREATE"i __ "CONTINUOUS"i __ "QUERY"i __ name:Identifier __ "ON"i __ database:Identifier 
    resample:ResampleClause?
    __ "BEGIN"i __ 
    query:SelectStatement 
    __ "END"i {
      return { 
        type: 'CREATE_CONTINUOUS_QUERY', 
        name, 
        database, 
        resample,
        query 
      };
    }

ResampleClause
  = __ "RESAMPLE"i every:EveryClause? forTime:ForClause? {
      return { every, for: forTime };
    }

EveryClause
  = __ "EVERY"i __ duration:Duration {
      return duration;
    }

ForClause
  = __ "FOR"i __ duration:Duration {
      return duration;
    }

// ALTER Statements
AlterStatement
  = AlterRetentionPolicyStatement

AlterRetentionPolicyStatement
  = "ALTER"i __ "RETENTION"i __ "POLICY"i __ name:Identifier __ "ON"i __ database:Identifier 
    options:AlterRetentionOption+ {
      return { type: 'ALTER_RETENTION_POLICY', name, database, options };
    }

AlterRetentionOption
  = RetentionOption
  / DefaultOption

// DROP Statements
DropStatement
  = DropDatabaseStatement
  / DropSeriesStatement
  / DropMeasurementStatement
  / DropRetentionPolicyStatement
  / DropContinuousQueryStatement

DropDatabaseStatement
  = "DROP"i __ "DATABASE"i __ name:Identifier {
      return { type: 'DROP_DATABASE', name };
    }

DropSeriesStatement
  = "DROP"i __ "SERIES"i __ "FROM"i __ measurement:Identifier where:WhereClause? {
      return { type: 'DROP_SERIES', measurement, where };
    }

DropMeasurementStatement
  = "DROP"i __ "MEASUREMENT"i __ name:Identifier {
      return { type: 'DROP_MEASUREMENT', name };
    }

DropRetentionPolicyStatement
  = "DROP"i __ "RETENTION"i __ "POLICY"i __ name:Identifier __ "ON"i __ database:Identifier {
      return { type: 'DROP_RETENTION_POLICY', name, database };
    }

DropContinuousQueryStatement
  = "DROP"i __ "CONTINUOUS"i __ "QUERY"i __ name:Identifier __ "ON"i __ database:Identifier {
      return { type: 'DROP_CONTINUOUS_QUERY', name, database };
    }

// DELETE Statement
DeleteStatement
  = "DELETE"i __ "FROM"i __ measurement:Identifier where:WhereClause? {
      return { type: 'DELETE', measurement, where };
    }

// Options
WithClause
  = __ "WITH"i __ options:DatabaseOptions {
      return options;
    }

DatabaseOptions
  = first:DatabaseOption rest:(__ DatabaseOption)* {
      const options = {};
      [first, ...rest.map(r => r[1])].forEach(opt => {
        Object.assign(options, opt);
      });
      return options;
    }

DatabaseOption
  = "DURATION"i __ dur:(Duration / "INF"i { return "INF"; }) {
      return { duration: dur };
    }
  / "REPLICATION"i __ count:Integer {
      return { replication: count };
    }
  / "SHARD"i __ "DURATION"i __ dur:Duration {
      return { shardDuration: dur };
    }
  / "NAME"i __ name:Identifier {
      return { name };
    }

RetentionOption
  = __ "DURATION"i __ duration:(Duration / "INF"i { return "INF"; }) { return { type: 'duration', value: duration }; }
  / __ "REPLICATION"i __ count:Integer { return { type: 'replication', value: count }; }
  / __ "SHARD"i __ "DURATION"i __ duration:Duration { return { type: 'shardDuration', value: duration }; }

DefaultOption
  = __ "DEFAULT"i { return true; }

// Literals
Duration
  = num:Integer unit:DurationUnit {
      return { value: num, unit };
    }

DurationUnit
  = "ms" { return 'ms'; }  // Check 'ms' before 'm'
  / "µ" { return 'µ'; }
  / "u" { return 'u'; }
  / "s" { return 's'; }
  / "m" { return 'm'; }
  / "h" { return 'h'; }
  / "d" { return 'd'; }
  / "w" { return 'w'; }

Identifier
  = QuotedIdentifier
  / UnquotedIdentifier

UnquotedIdentifier
  = first:[a-zA-Z_] rest:[a-zA-Z0-9_]* {
      return first + rest.join('');
    }

QuotedIdentifier
  = '"' chars:DoubleQuotedChar* '"' {
      return chars.join('');
    }

DoubleQuotedChar
  = '\\"' { return '"'; }
  / [^"]

String
  = "'" chars:SingleQuotedChar* "'" {
      return chars.join('');
    }

SingleQuotedChar
  = "\\'" { return "'"; }
  / [^']

RegexLiteral
  = "/" chars:RegexChar* "/" {
      return chars.join('');
    }

RegexChar
  = "\\/" { return "/"; }
  / [^/]

Number
  = Float
  / Integer

Integer
  = sign:[+-]? digits:[0-9]+ {
      return parseInt((sign || '') + digits.join(''), 10);
    }

Float
  = sign:[+-]? int:[0-9]* "." frac:[0-9]+ {
      return parseFloat((sign || '') + int.join('') + '.' + frac.join(''));
    }

// Whitespace
__ "whitespace"
  = [ \t\n\r]*

_ "required whitespace"
  = [ \t\n\r]+