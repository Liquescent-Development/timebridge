// LogQL Grammar for Loki
// Based on official Loki LogQL syntax

{
  function makeList(head, tail, index) {
    return [head].concat(tail.map(item => item[index]));
  }

  function makeBinaryExpr(head, tail) {
    return tail.reduce((left, element) => ({
      type: 'binary',
      operator: element[1],
      left: left,
      right: element[3],
      vectorMatching: element[2]
    }), head);
  }

  function makeLogRange(selector, duration, pipeline, offset) {
    return {
      type: 'logRange',
      selector: selector,
      duration: duration,
      pipeline: pipeline || null,
      offset: offset || null
    };
  }
}

// ============================================================================
// Top Level Rules
// ============================================================================

Query
  = __ expr:Expression __ {
      return expr;
    }

Expression
  = MetricExpression
  / LogExpression

LogExpression
  = selector:Selector pipeline:Pipeline? range:RangeSelector? offset:OffsetExpr? {
      // Handle both {job="nginx"} |= "error" [5m] and {job="nginx"}[5m]
      return {
        type: 'log',
        selector: selector,
        range: range || null,
        pipeline: pipeline || [],
        offset: offset || null
      };
    }
  / selector:Selector range:RangeSelector offset:OffsetExpr? {
      return {
        type: 'log',
        selector: selector,
        range: range,
        pipeline: [],
        offset: offset || null
      };
    }
  / "(" __ expr:LogExpression __ ")" { return expr; }

MetricExpression
  = BinaryExpression

// ============================================================================
// Selectors
// ============================================================================

Selector
  = "{" __ matchers:LabelMatchers? __ "}" {
      return {
        type: 'selector',
        matchers: matchers || []
      };
    }

LabelMatchers
  = head:LabelMatcher tail:(__ "," __ LabelMatcher)* __ ","? {
      return makeList(head, tail, 3);
    }

LabelMatcher
  = label:LabelName __ op:MatchOperator __ value:String {
      return {
        type: 'matcher',
        label: label,
        operator: op,
        value: value
      };
    }

LabelName
  = !Digits name:Identifier {
      return name;
    }
  / digits:Digits {
      error(`Invalid label name: "${digits}". Label names cannot be purely numeric.`);
    }

MatchOperator
  = "=~" { return '=~'; }
  / "!~" { return '!~'; }
  / "!=" { return '!='; }
  / "=" { return '='; }

// ============================================================================
// Range Selector
// ============================================================================

RangeSelector
  = __ "[" __ duration:Duration __ "]" {
      return duration;
    }

// ============================================================================
// Pipeline Operations
// ============================================================================

Pipeline
  = stages:PipelineStage+ {
      return stages;
    }

PipelineStage
  = DirectLineFilter
  / PipedStage

DirectLineFilter
  = __ op:DirectLineOp __ value:FilterValue {
      return {
        type: 'lineFilter',
        operator: op,
        value: value
      };
    }

DirectLineOp
  = "|=" { return '|='; }
  / "!=" { return '!='; }
  / "|~" { return '|~'; }
  / "!~" { return '!~'; }
  / "|>" { return '|>'; }
  / "!>" { return '!>'; }

PipedStage
  = __ "|" __ stage:(
      Parser
    / LabelFilter
    / LineFormat
    / LabelFormat
    / Decolorize
    / DropLabels
    / KeepLabels
  ) { return stage; }

// ============================================================================
// Filter Values
// ============================================================================

FilterValue
  = IPFilter
  / OrFilter
  / String

IPFilter
  = "ip" __ "(" __ cidr:String __ ")" {
      return {
        type: 'ip',
        cidr: cidr
      };
    }

OrFilter
  = head:String tail:(__ ("or" / "OR") __ String)+ {
      return {
        type: 'or',
        values: makeList(head, tail, 3)
      };
    }

// ============================================================================
// Parsers
// ============================================================================

Parser
  = JSONParser
  / LogfmtParser
  / PatternParser
  / RegexpParser
  / UnpackParser

JSONParser
  = "json" extractions:ExtractionList? {
      return {
        type: 'parser',
        parser: 'json',
        extractions: extractions || []
      };
    }

LogfmtParser
  = "logfmt" flags:ParserFlags? extractions:ExtractionList? {
      return {
        type: 'parser',
        parser: 'logfmt',
        flags: flags || [],
        extractions: extractions || []
      };
    }

PatternParser
  = "pattern" __ pattern:String {
      return {
        type: 'parser',
        parser: 'pattern',
        pattern: pattern
      };
    }

RegexpParser
  = "regexp" __ pattern:String {
      return {
        type: 'parser',
        parser: 'regexp',
        pattern: pattern
      };
    }

UnpackParser
  = "unpack" {
      return {
        type: 'parser',
        parser: 'unpack'
      };
    }

ParserFlags
  = flags:ParserFlag+ {
      return flags;
    }

ParserFlag
  = __ flag:("--strict" / "--keep-empty") {
      return flag;
    }

ExtractionList
  = __ head:Extraction tail:(__ "," __ Extraction)* {
      return makeList(head, tail, 3);
    }

Extraction
  = label:Identifier __ "=" __ path:String {
      return {
        label: label,
        path: path
      };
    }
  / label:Identifier {
      return {
        label: label,
        path: label
      };
    }

// ============================================================================
// Label Filters
// ============================================================================

LabelFilter
  = LabelLogicalExpression

LabelLogicalExpression
  = head:LabelComparison tail:(__ LogicalOp __ LabelComparison)* {
      if (tail.length === 0) return head;
      return tail.reduce((left, element) => ({
        type: 'labelLogical',
        operator: element[1],
        left: left,
        right: element[3]
      }), head);
    }

LabelComparison
  = label:Identifier __ op:ComparisonOp __ value:FilterRHS {
      return {
        type: 'labelFilter',
        label: label,
        operator: op,
        value: value
      };
    }
  / "(" __ filter:LabelLogicalExpression __ ")" { return filter; }

ComparisonOp
  = "==" { return '=='; }
  / "!=" { return '!='; }
  / ">=" { return '>='; }
  / "<=" { return '<='; }
  / ">" { return '>'; }
  / "<" { return '<'; }
  / "=" { return '=='; }

LogicalOp
  = "and" { return 'and'; }
  / "or" { return 'or'; }
  / "," { return 'and'; }

FilterRHS
  = Duration
  / Bytes
  / Number
  / IPFilter
  / String

// ============================================================================
// Formatting
// ============================================================================

LineFormat
  = "line_format" __ template:String {
      return {
        type: 'lineFormat',
        template: template
      };
    }

LabelFormat
  = "label_format" __ formats:LabelFormatList {
      return {
        type: 'labelFormat',
        formats: formats
      };
    }

LabelFormatList
  = head:LabelFormatItem tail:(__ "," __ LabelFormatItem)* {
      return makeList(head, tail, 3);
    }

LabelFormatItem
  = label:Identifier __ "=" __ value:String {
      return {
        label: label,
        value: value
      };
    }

Decolorize
  = "decolorize" {
      return {
        type: 'decolorize'
      };
    }

DropLabels
  = "drop" __ labels:IdentifierList {
      return {
        type: 'dropLabels',
        labels: labels
      };
    }

KeepLabels
  = "keep" __ labels:IdentifierList {
      return {
        type: 'keepLabels',
        labels: labels
      };
    }

IdentifierList
  = head:Identifier tail:(__ "," __ Identifier)* {
      return makeList(head, tail, 3);
    }

// ============================================================================
// Range and Unwrap
// ============================================================================

LogRange
  = selector:Selector pipeline:Pipeline? __ "[" __ duration:Duration __ "]" offset:OffsetExpr? {
      return {
        type: 'logRange',
        selector: selector,
        duration: duration,
        pipeline: pipeline || [],
        offset: offset || null
      };
    }
  / selector:Selector __ "[" __ duration:Duration __ "]" offset:OffsetExpr? pipeline:Pipeline? {
      return {
        type: 'logRange',
        selector: selector,
        duration: duration,
        pipeline: pipeline || [],
        offset: offset || null
      };
    }

UnwrappedExpression
  = selector:Selector pipeline:Pipeline? __ "|" __ "unwrap" __ field:UnwrapField __ "[" __ duration:Duration __ "]" offset:OffsetExpr? {
      return {
        type: 'unwrapped',
        selector: selector,
        pipeline: pipeline || [],
        field: field,
        duration: duration,
        offset: offset || null
      };
    }

UnwrapField
  = conv:ConversionFunc __ "(" __ field:Identifier __ ")" {
      return {
        field: field,
        conversion: conv
      };
    }
  / field:Identifier {
      return {
        field: field,
        conversion: null
      };
    }

ConversionFunc
  = "bytes" { return 'bytes'; }
  / "duration_seconds" { return 'duration_seconds'; }
  / "duration" { return 'duration'; }

OffsetExpr
  = __ "offset" __ duration:Duration {
      return duration;
    }

// ============================================================================
// Aggregations
// ============================================================================

RangeAggregation
  = op:RangeOp __ "(" __ param:Number? __ ","? __ expr:(UnwrappedExpression / LogRange) __ ")" by:GroupingClause? {
      return {
        type: 'rangeAggregation',
        operation: op,
        parameter: param || null,
        expression: expr,
        grouping: by
      };
    }

RangeOp
  = "count_over_time"
  / "rate"
  / "rate_counter"
  / "bytes_over_time"
  / "bytes_rate"
  / "absent_over_time"
  / "sum_over_time"
  / "avg_over_time"
  / "max_over_time"
  / "min_over_time"
  / "first_over_time"
  / "last_over_time"
  / "stddev_over_time"
  / "stdvar_over_time"
  / "quantile_over_time"

VectorAggregation
  = op:VectorOp __ "(" __ param:Number? __ ","? __ expr:MetricExpression __ ")" by:GroupingClause? {
      return {
        type: 'vectorAggregation',
        operation: op,
        parameter: param || null,
        expression: expr,
        grouping: by
      };
    }
  / op:VectorOp by:GroupingClause __ "(" __ param:Number? __ ","? __ expr:MetricExpression __ ")" {
      return {
        type: 'vectorAggregation',
        operation: op,
        parameter: param || null,
        expression: expr,
        grouping: by
      };
    }

VectorOp
  = "sum"
  / "avg"
  / "max"
  / "min"
  / "count"
  / "stddev"
  / "stdvar"
  / "topk"
  / "bottomk"

GroupingClause
  = __ "by" __ "(" __ labels:IdentifierList __ ")" {
      return {
        type: 'by',
        labels: labels
      };
    }
  / __ "without" __ "(" __ labels:IdentifierList __ ")" {
      return {
        type: 'without',
        labels: labels
      };
    }

// ============================================================================
// Binary Operations
// ============================================================================

BinaryExpression
  = OrExpression

OrExpression
  = head:AndExpression tail:(__ "or" VectorMatching? __ AndExpression)* {
      return makeBinaryExpr(head, tail);
    }

AndExpression
  = head:UnlessExpression tail:(__ "and" VectorMatching? __ UnlessExpression)* {
      return makeBinaryExpr(head, tail);
    }

UnlessExpression
  = head:ComparisonExpression tail:(__ "unless" VectorMatching? __ ComparisonExpression)* {
      return makeBinaryExpr(head, tail);
    }

ComparisonExpression
  = head:AddExpression tail:(__ ComparisonOperator VectorMatching? __ AddExpression)* {
      return makeBinaryExpr(head, tail);
    }

ComparisonOperator
  = "==" / "!=" / "<=" / ">=" / "<" / ">"

AddExpression
  = head:MultExpression tail:(__ ("+" / "-") VectorMatching? __ MultExpression)* {
      return makeBinaryExpr(head, tail);
    }

MultExpression
  = head:PowExpression tail:(__ ("*" / "/" / "%") VectorMatching? __ PowExpression)* {
      return makeBinaryExpr(head, tail);
    }

PowExpression
  = head:UnaryExpression tail:(__ "^" VectorMatching? __ UnaryExpression)* {
      return makeBinaryExpr(head, tail);
    }

UnaryExpression
  = RangeAggregation
  / VectorAggregation
  / UnwrappedExpression
  / LabelReplaceExpression
  / VectorFunction
  / LiteralExpression
  / "(" __ expr:MetricExpression __ ")" { return expr; }

LiteralExpression
  = value:Number {
      return {
        type: 'literal',
        value: value
      };
    }

VectorMatching
  = __ "on" __ "(" __ labels:IdentifierList __ ")" grouping:GroupingModifier? {
      return {
        type: 'on',
        labels: labels,
        grouping: grouping
      };
    }
  / __ "ignoring" __ "(" __ labels:IdentifierList __ ")" grouping:GroupingModifier? {
      return {
        type: 'ignoring',
        labels: labels,
        grouping: grouping
      };
    }

GroupingModifier
  = __ "group_left" __ "(" __ labels:IdentifierList? __ ")" {
      return {
        type: 'group_left',
        labels: labels || []
      };
    }
  / __ "group_right" __ "(" __ labels:IdentifierList? __ ")" {
      return {
        type: 'group_right',
        labels: labels || []
      };
    }

// ============================================================================
// Functions
// ============================================================================

LabelReplaceExpression
  = "label_replace" __ "(" __ expr:MetricExpression __ "," __ dst:String __ "," __ replacement:String __ "," __ src:String __ "," __ regex:String __ ")" {
      return {
        type: 'labelReplace',
        expression: expr,
        destination: dst,
        replacement: replacement,
        source: src,
        regex: regex
      };
    }

VectorFunction
  = "vector" __ "(" __ value:Number __ ")" {
      return {
        type: 'vector',
        value: value
      };
    }

// ============================================================================
// Literals and Values
// ============================================================================

Duration
  = parts:DurationPart+ {
      return {
        type: 'duration',
        value: parts.join('')
      };
    }

DurationPart
  = num:Integer unit:DurationUnit {
      return num + unit;
    }

DurationUnit
  = "ms" / "s" / "m" / "h" / "d" / "w" / "y"

Bytes
  = num:Number __ unit:BytesUnit {
      return {
        type: 'bytes',
        value: num,
        unit: unit
      };
    }

BytesUnit
  = "B" / "KB" / "KiB" / "MB" / "MiB" / "GB" / "GiB" / "TB" / "TiB" / "PB" / "PiB"

Number
  = Float
  / Integer

Float
  = sign:Sign? int:Digits? "." frac:Digits exp:Exponent? {
      const num = (sign || '') + (int || '0') + '.' + frac + (exp || '');
      return parseFloat(num);
    }

Integer  
  = sign:Sign? digits:Digits {
      return parseInt((sign || '') + digits, 10);
    }

Exponent
  = [eE] sign:Sign? digits:Digits {
      return 'e' + (sign || '') + digits;
    }

Sign = [+-]

Digits = $[0-9]+

String
  = QuotedString
  / BacktickString

QuotedString
  = '"' chars:DoubleQuotedChar* '"' {
      return chars.join('');
    }

DoubleQuotedChar
  = '\\' seq:EscapeSequence { return seq; }
  / [^"\\]

EscapeSequence
  = '"' { return '"'; }
  / '\\' { return '\\'; }
  / 'n' { return '\n'; }
  / 'r' { return '\r'; }
  / 't' { return '\t'; }
  / 'd' { return '\\d'; }
  / 's' { return '\\s'; }
  / 'S' { return '\\S'; }
  / '.' { return '.'; }
  / char:. { return '\\' + char; }

BacktickString
  = '`' chars:[^`]* '`' {
      return chars.join('');
    }

Identifier
  = !ReservedWord name:$([a-zA-Z_][a-zA-Z0-9_]*) {
      return name;
    }

// ============================================================================
// Reserved Words
// ============================================================================

ReservedWord
  = ("and" / "or" / "unless" / "by" / "without" / "on" / "ignoring" / 
     "group_left" / "group_right" / "offset" / "bool") !IdentifierPart

IdentifierPart = [a-zA-Z0-9_]

// ============================================================================
// Whitespace and Comments
// ============================================================================

__ "whitespace"
  = (Whitespace / Comment)*

Whitespace
  = [ \t\n\r]+

Comment
  = "#" [^\n]* ("\n" / EOF)

EOF = !.