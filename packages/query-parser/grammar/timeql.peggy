// TimeQL Parser Grammar for Peggy
// A PromQL-inspired query language for log correlation and direct queries

Query
  = _ query:(AggregationQuery / PatternQuery / CorrelationQuery / DirectQuery) _ {
      return query;
    }

// Pattern matching query (e.g., events{service="auth"}[5m] follows events{service="api"}[5m] within(30s))
PatternQuery
  = sequence:EventSequence {
      return {
        type: 'pattern',
        sequence: sequence
      };
    }

// Event sequence for pattern matching
EventSequence
  = first:StreamExpr _ op:PatternOperator _ second:StreamExpr constraint:TemporalConstraint? {
      return {
        first: first,
        operator: op,
        second: second,
        constraint: constraint
      };
    }

// Pattern operators
PatternOperator
  = "follows" { return 'follows'; }
  / "precedes" { return 'precedes'; }
  / "before" { return 'before'; }
  / "after" { return 'after'; }

// Temporal constraint for patterns
TemporalConstraint
  = __ "within" _ "(" _ duration:Duration _ ")" {
      return { type: 'within', duration: duration };
    }

// Aggregation query (e.g., sum by(service) (events[1h]))
AggregationQuery
  = func:AggregationFunc _ grouping:GroupingClause? _ "(" _ query:InnerQuery _ ")" {
      return {
        type: 'aggregation',
        function: func,
        groupBy: grouping || [],
        query: query
      };
    }

// Inner query for aggregations (can be direct or correlation)
InnerQuery
  = CorrelationQuery
  / DirectQuery

// Single stream query (no joins)
DirectQuery
  = stream:StreamExpr filter:Filter? {
      return {
        type: 'direct',
        stream: stream,
        filter
      };
    }

// Multi-stream correlation query (with joins)
CorrelationQuery
  = streams:StreamList filter:Filter? {
      const result = {
        type: 'correlation',
        leftStream: streams[0],
        rightStream: streams[1],
        joinType: streams[0].join?.type || 'and',
        joinKeys: streams[0].join?.keys || [],
        temporal: streams[0].join?.temporal,
        grouping: streams[0].join?.grouping,
        labelMappings: streams[0].join?.labelMappings,
        filter
      };
      
      if (streams.length > 2) {
        result.additionalStreams = streams.slice(2);
      }
      
      return result;
    }

StreamList
  = first:StreamExpr rest:(_ JoinedStream)+ {  // Note the + instead of * to require at least one join
      return [first, ...rest.map(r => r[1])];
    }

JoinedStream
  = join:JoinOperator _ stream:StreamExpr {
      stream.join = join;
      return stream;
    }

StreamExpr
  = DatabaseExpr
  / SourceStreamExpr

// Query persisted data in DuckDB
DatabaseExpr
  = "events" selector:LabelSelector? _ timeSpec:TimeSpecification {
      return Object.assign({
        type: 'database',
        source: 'events',  // Special source indicating persisted data
        selector: selector ? selector.text : '{}',
        selectorParsed: selector ? selector.parsed : { type: 'labels', matchers: [] }
      }, timeSpec);
    }

// Query from external sources (existing behavior)
SourceStreamExpr
  = source:DataSourceNameWithStream _ "(" _ selector:Selector _ ")" _ timeSpec:TimeSpecification {
      // Check if source contains a colon for stream specification
      const colonIndex = source.indexOf(':');
      const baseResult = colonIndex > -1 ? {
        source: source.substring(0, colonIndex),
        stream: source.substring(colonIndex + 1),
        selector: selector.text,
        selectorParsed: selector.parsed
      } : {
        source,
        selector: selector.text,
        selectorParsed: selector.parsed
      };
      
      return Object.assign(baseResult, timeSpec);
    }

// Data source names with optional stream specification
DataSourceNameWithStream
  = [a-zA-Z][a-zA-Z0-9_\-:]+ { 
      return text(); 
    }

// Data source names - can include hyphens and numbers (e.g., graylog-ap-northeast-1)
DataSourceName
  = [a-zA-Z][a-zA-Z0-9_\-]+ { 
      return text(); 
    }

// Stream names are simpler identifiers
StreamName
  = [a-zA-Z][a-zA-Z0-9_\-]* { return text(); }

Selector
  = LabelSelector
  / GraylogSelector  
  / PromQLSelector

LabelSelector
  = "{" _ matchers:LabelMatcherList? _ "}" {
      return {
        text: `{${matchers ? matchers.map(m => m.text).join(',') : ''}}`,
        parsed: { type: 'labels', matchers: matchers || [] }
      };
    }

GraylogSelector
  = expr:GraylogExpr {
      return {
        text: expr.text,
        parsed: { type: 'graylog', expr: expr.parsed }
      };
    }

GraylogExpr
  = left:GraylogAndExpr _ "OR" _ right:GraylogExpr {
      return {
        text: `${left.text} OR ${right.text}`,
        parsed: { op: 'OR', left: left.parsed, right: right.parsed }
      };
    }
  / GraylogAndExpr

GraylogAndExpr
  = left:GraylogNotExpr _ "AND" _ right:GraylogAndExpr {
      return {
        text: `${left.text} AND ${right.text}`,
        parsed: { op: 'AND', left: left.parsed, right: right.parsed }
      };
    }
  / GraylogNotExpr

GraylogNotExpr
  = "NOT" _ expr:GraylogNotExpr {
      return {
        text: `NOT ${expr.text}`,
        parsed: { op: 'NOT', expr: expr.parsed }
      };
    }
  / GraylogPrimaryExpr

GraylogPrimaryExpr
  = "(" _ expr:GraylogExpr _ ")" {
      return {
        text: `(${expr.text})`,
        parsed: expr.parsed
      };
    }
  / GraylogTerm

GraylogTerm
  = "_exists_:" field:FieldName {
      return {
        text: `_exists_:${field}`,
        parsed: { op: 'exists', field }
      };
    }
  / "_missing_:" field:FieldName {
      return {
        text: `_missing_:${field}`,
        parsed: { op: 'missing', field }
      };
    }
  / field:FieldName ":" "[" from:RangeValue _ "TO" _ to:RangeValue "]" {
      return {
        text: `${field}:[${from} TO ${to}]`,
        parsed: { op: 'range', field, from, to }
      };
    }
  / field:FieldName ":" op:ComparisonOp value:GraylogValue {
      return {
        text: `${field}:${op}${value}`,
        parsed: { op: 'comparison', field, operator: op, value }
      };
    }
  / field:FieldName ":" value:GraylogValue {
      return {
        text: `${field}:${value}`,
        parsed: { field, value }
      };
    }

RangeValue
  = Number { return text(); }
  / "*" { return text(); }
  / FieldName

ComparisonOp
  = ">=" / "<=" / ">" / "<"

PromQLSelector
  = metric:Identifier _ "{" _ matchers:LabelMatcherList? _ "}" {
      return {
        text: `${metric}{${matchers ? matchers.map(m => m.text).join(',') : ''}}`,
        parsed: { type: 'promql', metric, matchers: matchers || [] }
      };
    }
  / metric:Identifier {
      return {
        text: metric,
        parsed: { type: 'promql', metric, matchers: [] }
      };
    }

RawDataSource
  = "influxdb" { return "influxdb"; }
  / "custom-adapter" { return "custom-adapter"; }

RawSelector
  = chars:RawSelectorChar+ {
      const text = chars.join('');
      return {
        text,
        parsed: { type: 'raw', query: text }
      };
    }

RawSelectorChar
  = [^()]
  / "(" chars:RawSelectorChar* ")" { return "(" + chars.join('') + ")"; }

LabelMatcherList
  = first:LabelMatcher rest:(_ "," _ LabelMatcher)* {
      return [first, ...rest.map(r => r[3])];
    }

LabelMatcher
  = label:Identifier _ op:MatchOperator _ value:Value {
      return {
        text: `${label}${op}${value.raw}`,
        parsed: { label, op, value: value.value }
      };
    }

// Removed old GraylogMatcherList and GraylogMatcher as they're replaced

MatchOperator
  = "=~" / "!~" / "!=" / "="

Value
  = s:String { return { raw: s.raw, value: s.value }; }
  / i:Identifier { return { raw: i, value: i }; }

GraylogValue
  = String { return text(); }
  / GraylogWildcardPhrase
  / UnquotedValue

// Matches values that contain wildcards, including phrases with spaces
// This handles patterns like "failed to transmit*"
GraylogWildcardPhrase
  = &{ 
      // Look ahead to see if this value contains a wildcard
      let pos = peg$currPos;
      let foundWildcard = false;
      let foundOperator = false;
      
      while (pos < input.length && !foundOperator) {
        if (input.substring(pos, pos + 5) === " AND " ||
            input.substring(pos, pos + 4) === " OR " ||
            input.substring(pos, pos + 5) === " NOT " ||
            input[pos] === ")" || input[pos] === "]") {
          foundOperator = true;
        } else if (input[pos] === "*") {
          foundWildcard = true;
        }
        pos++;
      }
      return foundWildcard;
    }
    chars:GraylogWildcardChar+ {
      return chars.join('').trim();
    }

// Characters in a wildcard phrase (stops at logical operators or closing brackets)
GraylogWildcardChar
  = !(" AND " / " OR " / " NOT " / ")" / "]") c:. { return c; }

JoinOperator
  = type:JoinType __ "on" _ "(" _ keys:JoinKeyList _ ")" modifiers:JoinModifier* {
      const result = {
        type,
        keys: keys.keys,
        labelMappings: keys.mappings
      };
      
      modifiers.forEach(mod => {
        Object.assign(result, mod);
      });
      
      return result;
    }

JoinType
  = "and" / "or" / "unless"

JoinKeyList
  = first:JoinKey rest:(_ "," _ JoinKey)* {
      const allKeys = [first, ...rest.map(r => r[3])];
      const keys = [];
      const mappings = [];
      
      allKeys.forEach(k => {
        if (k.mapping) {
          mappings.push(k.mapping);
          keys.push(k.mapping.left);
        } else {
          keys.push(k.key);
        }
      });
      
      return {
        keys,
        mappings: mappings.length > 0 ? mappings : undefined
      };
    }

JoinKey
  = left:FieldName _ "=" _ right:FieldName {
      return { mapping: { left, right } };
    }
  / key:FieldName {
      return { key };
    }

JoinModifier
  = __ "within" _ "(" _ duration:Duration _ ")" {
      return { temporal: duration };
    }
  / __ "ignoring" _ "(" _ labels:LabelList _ ")" {
      return { ignoring: labels };
    }
  / __ group:GroupModifier {
      return { grouping: group };
    }

GroupModifier
  = side:GroupSide _ "(" _ labels:LabelList? _ ")" {
      return { side, labels: labels || [] };
    }
  / side:GroupSide {
      return { side, labels: [] };
    }

GroupSide
  = "group_left" { return 'left'; }
  / "group_right" { return 'right'; }

LabelList
  = first:Identifier rest:(_ "," _ Identifier)* {
      return [first, ...rest.map(r => r[3])];
    }

Filter
  = _ "{" _ matchers:LabelMatcherList _ "}" {
      return `{${matchers.map(m => m.text).join(',')}}`;
    }

// Time specification: handles both relative and absolute time ranges
TimeSpecification
  = "[" _ range:TimeRange _ "]" at:AtModifier? {
      if (at) {
        return Object.assign(range, { at });
      }
      return range;
    }
  / at:AtModifier {
      return { at };
    }

// Time range: relative, absolute, or mixed
TimeRange
  = start:AbsoluteOrRelativeTimePoint _ "to" _ end:AbsoluteOrRelativeTimePoint {
      // This is an absolute or mixed range with explicit start and end
      return {
        timeRangeType: 'absolute',
        start,
        end
      };
    }
  / duration:SimpleDuration {
      // This is a simple relative range (just duration like "5m")
      return {
        timeRange: duration,
        timeRangeType: 'relative'
      };
    }

// Duration that can only appear as a simple range (not before "to")
SimpleDuration
  = num:Number unit:TimeUnit !(_ "to") { return num + unit; }

// Time points that can be used in absolute ranges
AbsoluteOrRelativeTimePoint
  = timestamp:ISOTimestamp { return { type: 'absolute', value: timestamp }; }
  / "now" { return { type: 'now' }; }
  / num:Number unit:TimeUnit _ "ago" { return { type: 'relative', value: num + unit, direction: 'ago' }; }
  / "+" num:Number unit:TimeUnit { return { type: 'relative', value: num + unit, direction: 'future' }; }

// @ modifier for point-in-time queries
AtModifier
  = _ "@" _ timestamp:ISOTimestamp {
      return timestamp;
    }

// ISO 8601 timestamp (simplified - handles common formats)
ISOTimestamp
  = date:DatePart "T" time:TimePart tz:TimeZone? {
      return date + "T" + time + (tz || "Z");
    }
  / date:DatePart {
      return date + "T00:00:00Z";  // Default to midnight UTC
    }

DatePart
  = year:Year "-" month:Month "-" day:Day {
      return year + "-" + month + "-" + day;
    }

TimePart
  = hour:Hour ":" minute:Minute ":" second:Second fraction:FractionalSecond? {
      return hour + ":" + minute + ":" + second + (fraction || "");
    }

TimeZone
  = "Z" { return "Z"; }
  / sign:[+-] hour:Hour ":" minute:Minute {
      return sign + hour + ":" + minute;
    }

Year = [0-9][0-9][0-9][0-9] { return text(); }
Month = [0-1][0-9] { return text(); }
Day = [0-3][0-9] { return text(); }
Hour = [0-2][0-9] { return text(); }
Minute = [0-5][0-9] { return text(); }
Second = [0-5][0-9] { return text(); }
FractionalSecond = "." [0-9]+ { return text(); }

Duration
  = num:Number unit:TimeUnit { return num + unit; }

TimeUnit
  = "s" / "m" / "h" / "d" / "w"

String
  = '"' chars:DoubleStringChar* '"' {
      return { raw: `"${chars.join('')}"`, value: chars.join('') };
    }
  / "'" chars:SingleStringChar* "'" {
      return { raw: `'${chars.join('')}'`, value: chars.join('') };
    }

DoubleStringChar
  = [^"\\]
  / "\\" char:. { return char; }

SingleStringChar
  = [^'\\]
  / "\\" char:. { return char; }

// Field names can contain hyphens and dots (for Graylog compatibility)
FieldName
  = [a-zA-Z_][a-zA-Z0-9_\-\.]* { return text(); }

// Original identifier for backwards compatibility
Identifier
  = [a-zA-Z_][a-zA-Z0-9_\-]* { return text(); }

UnquotedValue
  = [a-zA-Z0-9_\-\./:]+ { return text(); }

Number
  = [0-9]+ ("." [0-9]+)? { return text(); }

// Aggregation functions
AggregationFunc
  = "sum" / "avg" / "min" / "max" / "count" 
  / "rate" / "increase" / "topk" / "bottomk"

// Grouping clause for aggregations (e.g., by(service, region))
GroupingClause
  = "by" _ "(" _ labels:LabelList _ ")" {
      return labels;
    }

// Whitespace
_ = [ \t\r\n]*
__ = [ \t\r\n]+