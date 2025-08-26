// LogQL Parser Grammar for Peggy
// A PromQL-inspired query language for log correlation

Query
  = streams:StreamList filter:Filter? {
      const result = {
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
  = first:StreamExpr rest:(_ JoinedStream)* {
      return [first, ...rest.map(r => r[1])];
    }

JoinedStream
  = join:JoinOperator _ stream:StreamExpr {
      stream.join = join;
      return stream;
    }

StreamExpr
  = source:Identifier _ "(" _ selector:Selector _ ")" _ "[" _ duration:Duration _ "]" {
      return {
        source,
        selector: selector.text,
        timeRange: duration,
        selectorParsed: selector.parsed
      };
    }

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
  / WildcardValue
  / UnquotedValue

WildcardValue
  = chars:[a-zA-Z0-9_\-\./\\]* "*" rest:[a-zA-Z0-9_\-\./\\*]* { 
      return chars.join('') + '*' + rest.join(''); 
    }
  / "*" rest:[a-zA-Z0-9_\-\./\\]+ { 
      return '*' + rest.join(''); 
    }

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

Duration
  = num:Number unit:TimeUnit { return num + unit; }

TimeUnit
  = "s" / "m" / "h" / "d"

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
  = [a-zA-Z_][a-zA-Z0-9_:]* { return text(); }

UnquotedValue
  = [a-zA-Z0-9_\-\./:]+ { return text(); }

Number
  = [0-9]+ ("." [0-9]+)? { return text(); }

// Whitespace
_ = [ \t\r\n]*
__ = [ \t\r\n]+