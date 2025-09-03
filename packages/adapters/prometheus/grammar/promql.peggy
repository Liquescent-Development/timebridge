// PromQL Grammar for Peggy Parser Generator
// Based on Prometheus Query Language specification

{
  // Helper function to build binary expression tree with proper precedence
  function buildBinaryExpression(head, tail, operatorIndex) {
    return tail.reduce((left, element) => {
      const [, op, , right] = element;
      return {
        type: 'binary',
        operator: op,
        left: left,
        right: right
      };
    }, head);
  }

  // Helper to extract string from various quote styles
  function extractString(chars) {
    return chars.join('');
  }

  // Helper to parse duration strings
  function parseDuration(parts) {
    let totalMs = 0;
    for (const part of parts) {
      const value = parseInt(part.value);
      const unit = part.unit;
      switch(unit) {
        case 'ms': totalMs += value; break;
        case 's': totalMs += value * 1000; break;
        case 'm': totalMs += value * 60 * 1000; break;
        case 'h': totalMs += value * 60 * 60 * 1000; break;
        case 'd': totalMs += value * 24 * 60 * 60 * 1000; break;
        case 'w': totalMs += value * 7 * 24 * 60 * 60 * 1000; break;
        case 'y': totalMs += value * 365 * 24 * 60 * 60 * 1000; break;
      }
    }
    return {
      type: 'duration',
      value: totalMs,
      raw: parts.map(p => p.value + p.unit).join('')
    };
  }
}

// ============================================================================
// Entry Point
// ============================================================================

Query
  = __ expr:Expression __ EOF {
      return {
        type: 'query',
        expression: expr
      };
    }
  / __ EOF {
      return {
        type: 'query',
        expression: null
      };
    }

// ============================================================================
// Expressions (with operator precedence)
// ============================================================================

Expression
  = OrExpression

OrExpression
  = head:UnlessExpression tail:(__ "or" GroupingModifier? __ UnlessExpression)* {
      return tail.reduce((left, element) => {
        const [, op, grouping, , right] = element;
        return {
          type: 'binary',
          operator: op,
          left: left,
          right: right,
          vectorMatching: grouping
        };
      }, head);
    }

UnlessExpression
  = head:AndExpression tail:(__ "unless" GroupingModifier? __ AndExpression)* {
      return tail.reduce((left, element) => {
        const [, op, grouping, , right] = element;
        return {
          type: 'binary',
          operator: op,
          left: left,
          right: right,
          vectorMatching: grouping
        };
      }, head);
    }

AndExpression
  = head:ComparisonExpression tail:(__ "and" GroupingModifier? __ ComparisonExpression)* {
      return tail.reduce((left, element) => {
        const [, op, grouping, , right] = element;
        return {
          type: 'binary',
          operator: op,
          left: left,
          right: right,
          vectorMatching: grouping
        };
      }, head);
    }

ComparisonExpression
  = head:AdditiveExpression tail:(__ ComparisonOperator BoolModifier? __ AdditiveExpression)* {
      return tail.reduce((left, element) => {
        const [, op, boolMod, , right] = element;
        return {
          type: 'comparison',
          operator: op,
          left: left,
          right: right,
          bool: boolMod !== null
        };
      }, head);
    }

ComparisonOperator
  = "==" { return '=='; }
  / "!=" { return '!='; }
  / "<=" { return '<='; }
  / ">=" { return '>='; }
  / "<"  { return '<'; }
  / ">"  { return '>'; }

BoolModifier
  = __ "bool" { return true; }

AdditiveExpression
  = head:MultiplicativeExpression tail:(__ AddSubOperator GroupingModifier? __ MultiplicativeExpression)* {
      return tail.reduce((left, element) => {
        const [, op, grouping, , right] = element;
        return {
          type: 'binary',
          operator: op,
          left: left,
          right: right,
          vectorMatching: grouping
        };
      }, head);
    }

AddSubOperator
  = "+" { return '+'; }
  / "-" { return '-'; }

MultiplicativeExpression
  = head:PowerExpression tail:(__ MulDivModOperator GroupingModifier? __ PowerExpression)* {
      return tail.reduce((left, element) => {
        const [, op, grouping, , right] = element;
        return {
          type: 'binary',
          operator: op,
          left: left,
          right: right,
          vectorMatching: grouping
        };
      }, head);
    }

MulDivModOperator
  = "*" { return '*'; }
  / "/" { return '/'; }
  / "%" { return '%'; }

PowerExpression
  = head:UnaryExpression tail:(__ "^" __ GroupingModifier? __ UnaryExpression)* {
      return tail.reduce((left, element) => {
        const [, op, , grouping, , right] = element;
        return {
          type: 'binary',
          operator: op,
          left: left,
          right: right,
          vectorMatching: grouping
        };
      }, head);
    }

UnaryExpression
  = op:UnaryOperator __ expr:UnaryExpression {
      return {
        type: 'unary',
        operator: op,
        expression: expr
      };
    }
  / PostfixExpression

UnaryOperator
  = "+" { return '+'; }
  / "-" { return '-'; }

PostfixExpression
  = expr:PrimaryExpression modifiers:(Modifier / AggregatePostfixModifier)* {
      return modifiers.reduce((acc, mod) => {
        if (mod.type === 'range') {
          return {
            type: 'matrix',
            expression: acc,
            range: mod.range
          };
        } else if (mod.type === 'offset') {
          return {
            type: 'offset',
            expression: acc,
            offset: mod.offset
          };
        } else if (mod.type === 'at') {
          return {
            type: 'at',
            expression: acc,
            timestamp: mod.timestamp
          };
        } else if (mod.type === 'subquery') {
          return {
            type: 'subquery',
            expression: acc,
            range: mod.range,
            step: mod.step
          };
        } else if ((mod.type === 'by' || mod.type === 'without') && acc.type === 'aggregation') {
          // Handle suffix aggregation modifiers
          acc.modifier = mod;
          return acc;
        }
        return acc;
      }, expr);
    }

Modifier
  = RangeSelector
  / SubquerySelector
  / OffsetModifier
  / AtModifier

AggregatePostfixModifier
  = __ mod:AggregateModifier {
      return mod;
    }

// ============================================================================
// Primary Expressions
// ============================================================================

PrimaryExpression
  = HistogramLiteral  // Check first due to {{ syntax
  / Number
  / String
  / AggregateExpression  // Check aggregations before functions
  / FunctionCall
  / Subexpression
  / VectorSelector  // Move to last to avoid matching before numbers

Subexpression
  = "(" __ expr:Expression __ ")" {
      return {
        type: 'subexpression',
        expression: expr
      };
    }

// ============================================================================
// Vector and Matrix Selectors
// ============================================================================

VectorSelector
  = metric:MetricIdentifier labels:LabelMatchers? {
      return {
        type: 'vector',
        metric: metric,
        labels: labels || []
      };
    }
  / labels:LabelMatchers {
      return {
        type: 'vector',
        metric: null,
        labels: labels
      };
    }

MetricIdentifier
  = !ReservedKeyword id:Identifier { return id; }

LabelMatchers
  = "{" __ matchers:LabelMatcherList? __ "}" {
      return matchers || [];
    }

LabelMatcherList
  = head:LabelMatcher tail:(__ "," __ LabelMatcher)* __ ","? {
      return [head, ...tail.map(t => t[3])];
    }

LabelMatcher
  = label:LabelName __ op:MatchOperator __ value:String {
      // Validate that label name is not purely numeric
      const labelStr = typeof label === 'string' ? label : label.value;
      if (labelStr && /^\d+$/.test(labelStr)) {
        error(`Invalid label name: "${labelStr}". Label names cannot be purely numeric.`);
      }
      return {
        type: 'matcher',
        label: label,
        operator: op,
        value: value
      };
    }
  / label:LabelName { // Shorthand for __name__="label"
      return {
        type: 'matcher',
        label: '__name__',
        operator: '=',
        value: label
      };
    }

LabelName
  = Identifier
  / QuotedLabelName

QuotedLabelName
  = str:String {
      // Quoted label names still can't be purely numeric
      const value = typeof str === 'string' ? str : str.value;
      if (/^\d+$/.test(value)) {
        error(`Invalid label name: "${value}". Label names cannot be purely numeric.`);
      }
      return str;
    }

MatchOperator
  = "=~" { return '=~'; }
  / "!~" { return '!~'; }
  / "!=" { return '!='; }
  / "="  { return '='; }

RangeSelector
  = "[" __ range:Duration __ "]" {
      return {
        type: 'range',
        range: range
      };
    }

SubquerySelector
  = "[" __ range:Duration __ ":" __ step:Duration? __ "]" {
      return {
        type: 'subquery',
        range: range,
        step: step
      };
    }

// ============================================================================
// Modifiers
// ============================================================================

OffsetModifier
  = __ "offset" __ duration:Duration {
      return {
        type: 'offset',
        offset: duration
      };
    }

AtModifier
  = __ "@" __ timestamp:AtTimestamp {
      return {
        type: 'at',
        timestamp: timestamp
      };
    }

AtTimestamp
  = "start" __ "(" __ ")" { return { type: 'start' }; }
  / "end" __ "(" __ ")" { return { type: 'end' }; }
  / num:Number { return { type: 'timestamp', value: num.value }; }

// ============================================================================
// Vector Matching
// ============================================================================

GroupingModifier
  = __ matching:VectorMatching { return matching; }

VectorMatching
  = OnClause GroupingClause?
  / IgnoringClause GroupingClause?

OnClause
  = "on" __ "(" __ labels:LabelList? __ ")" {
      return {
        type: 'on',
        labels: labels || []
      };
    }

IgnoringClause
  = "ignoring" __ "(" __ labels:LabelList? __ ")" {
      return {
        type: 'ignoring',
        labels: labels || []
      };
    }

GroupingClause
  = __ "group_left" __ "(" __ labels:LabelList? __ ")" {
      return {
        type: 'group_left',
        labels: labels || []
      };
    }
  / __ "group_left" {
      return {
        type: 'group_left',
        labels: []
      };
    }
  / __ "group_right" __ "(" __ labels:LabelList? __ ")" {
      return {
        type: 'group_right',
        labels: labels || []
      };
    }
  / __ "group_right" {
      return {
        type: 'group_right',
        labels: []
      };
    }

LabelList
  = head:LabelName tail:(__ "," __ LabelName)* {
      return [head, ...tail.map(t => t[3])];
    }

// ============================================================================
// Aggregations
// ============================================================================

AggregateExpression
  = op:AggregateOp __ mod:AggregateModifier? __ "(" __ params:AggregateParams? __ ")" {
      return {
        type: 'aggregation',
        operator: op,
        modifier: mod,
        params: params
      };
    }
  / op:AggregateOp __ "(" __ params:AggregateParams? __ ")" __ mod:AggregateModifier {
      return {
        type: 'aggregation',
        operator: op,
        modifier: mod,
        params: params
      };
    }

AggregateOp
  = "sum"
  / "min"
  / "max"
  / "avg"
  / "group"
  / "stddev"
  / "stdvar"
  / "count_values"  // Check before "count" to avoid partial match
  / "count"
  / "bottomk"
  / "topk"
  / "quantile"
  / "limitk"
  / "limit_ratio"

AggregateModifier
  = "by" __ "(" __ labels:LabelList? __ ")" {
      return {
        type: 'by',
        labels: labels || []
      };
    }
  / "without" __ "(" __ labels:LabelList? __ ")" {
      return {
        type: 'without',
        labels: labels || []
      };
    }

AggregateParams
  = param:Expression __ "," __ expr:Expression {
      return {
        parameter: param,
        expression: expr
      };
    }
  / expr:Expression {
      return {
        expression: expr
      };
    }

// ============================================================================
// Functions
// ============================================================================

FunctionCall
  = name:FunctionName __ "(" __ args:ArgumentList? __ ")" {
      return {
        type: 'function',
        name: name,
        arguments: args || []
      };
    }

FunctionName
  = !ReservedKeyword id:Identifier { return id; }

ArgumentList
  = head:Expression tail:(__ "," __ Expression)* {
      return [head, ...tail.map(t => t[3])];
    }

// ============================================================================
// Histogram Literals
// ============================================================================

HistogramLiteral
  = "{" "{" __ props:HistogramProperties? __ "}" "}" {
      return {
        type: 'histogram',
        properties: props || {}
      };
    }

HistogramProperties
  = head:HistogramProperty tail:(__ "," __ HistogramProperty)* {
      const props = [head, ...tail.map(t => t[3])];
      const result = {};
      for (const prop of props) {
        result[prop.key] = prop.value;
      }
      return result;
    }

HistogramProperty
  = key:Identifier __ ":" __ value:HistogramValue {
      return { key: key, value: value };
    }

HistogramValue
  = Number
  / HistogramBuckets
  / String

HistogramBuckets
  = "[" __ values:HistogramBucketList? __ "]" {
      return {
        type: 'buckets',
        values: values || []
      };
    }

HistogramBucketList
  = head:Number tail:(__ "," __ Number)* {
      return [head, ...tail.map(t => t[3])];
    }

// ============================================================================
// Basic Types
// ============================================================================

Number
  = Infinity
  / NaN
  / Hexadecimal
  / Octal
  / Scientific  // Must check before Decimal to catch e notation
  / Decimal

Infinity
  = sign:[+-]? "Inf" {
      return {
        type: 'number',
        value: sign === '-' ? -Infinity : Infinity
      };
    }

NaN
  = "NaN" {
      return {
        type: 'number',
        value: NaN
      };
    }

Scientific
  = sign:[+-]? int:$[0-9]+ frac:("." $[0-9]+)? [eE] exp:$([+-]? [0-9]+) {
      const num = int + (frac ? '.' + frac[1] : '');
      return {
        type: 'number',
        value: parseFloat((sign || '') + num + 'e' + exp)
      };
    }
  / sign:[+-]? "." frac:$[0-9]+ [eE] exp:$([+-]? [0-9]+) {
      const num = '0.' + frac;
      return {
        type: 'number',
        value: parseFloat((sign || '') + num + 'e' + exp)
      };
    }

Hexadecimal
  = sign:[+-]? "0x" digits:$[0-9a-fA-F]+ {
      const value = parseInt(digits, 16);
      return {
        type: 'number',
        value: sign === '-' ? -value : value
      };
    }

Octal
  = sign:[+-]? "0" digits:$[0-7]+ {
      const value = parseInt(digits, 8);
      return {
        type: 'number',
        value: sign === '-' ? -value : value
      };
    }

Decimal
  = sign:[+-]? int:$[0-9]+ frac:("." $[0-9]*)? {
      const fracPart = frac ? '.' + frac[1] : '';
      const value = parseFloat((sign || '') + int + fracPart);
      return {
        type: 'number',
        value: value
      };
    }
  / sign:[+-]? "." frac:$[0-9]+ {
      const value = parseFloat((sign || '') + '0.' + frac);
      return {
        type: 'number',
        value: value
      };
    }

String
  = DoubleQuotedString
  / SingleQuotedString
  / BacktickString

DoubleQuotedString
  = '"' chars:DoubleQuotedChar* '"' {
      return {
        type: 'string',
        value: chars.join('')
      };
    }

SingleQuotedString
  = "'" chars:SingleQuotedChar* "'" {
      return {
        type: 'string',
        value: chars.join('')
      };
    }

BacktickString
  = "`" chars:BacktickChar* "`" {
      return {
        type: 'string',
        value: chars.join('')
      };
    }

DoubleQuotedChar
  = '\\"' { return '"'; }
  / '\\\\' { return '\\'; }
  / '\\n' { return '\n'; }
  / '\\r' { return '\r'; }
  / '\\t' { return '\t'; }
  / [^"\\]

SingleQuotedChar
  = "\\'" { return "'"; }
  / '\\\\' { return '\\'; }
  / '\\n' { return '\n'; }
  / '\\r' { return '\r'; }
  / '\\t' { return '\t'; }
  / [^'\\]

BacktickChar
  = '\\`' { return '`'; }
  / '\\\\' { return '\\'; }
  / [^`\\]

Duration
  = parts:DurationPart+ {
      return parseDuration(parts);
    }

DurationPart
  = value:$[0-9]+ unit:DurationUnit {
      return { value: value, unit: unit };
    }

DurationUnit
  = "ms" / "s" / "m" / "h" / "d" / "w" / "y"

Identifier
  = $([a-zA-Z_:][a-zA-Z0-9_:]*)

// ============================================================================
// Reserved Keywords
// ============================================================================

ReservedKeyword
  = ("and" / "or" / "unless" / "bool") !IdentifierPart
  / ("on" / "ignoring" / "group_left" / "group_right") !IdentifierPart
  / ("offset" / "by" / "without") !IdentifierPart
  / ("Inf" / "NaN") !IdentifierPart

IdentifierPart
  = [a-zA-Z0-9_:]

// ============================================================================
// Whitespace and Comments
// ============================================================================

__ "whitespace"
  = (Whitespace / Comment)*

Whitespace
  = [ \t\n\r]+

Comment
  = "#" [^\n]*

EOF
  = !.