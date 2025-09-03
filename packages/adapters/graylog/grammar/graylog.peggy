// Graylog Query Grammar for Peggy
// Based on the Graylog Query Language Specification
// This grammar validates and parses Graylog search queries

// ============================================================================
// Main Query Entry Point
// ============================================================================

Query
  = query:Expression {
      return {
        type: 'query',
        expression: query
      };
    }
  / __ {
      // Empty query - matches all
      return {
        type: 'query',
        expression: { type: 'match_all' }
      };
    }

// ============================================================================
// Boolean Expressions
// ============================================================================

Expression
  = OrExpression

OrExpression
  = first:AndExpression rest:(__ "OR"i __ AndExpression)* {
      if (rest.length === 0) return first;
      
      // Check for case-sensitive OR
      rest.forEach(r => {
        if (r[1] !== 'OR') {
          error(`Boolean operator must be uppercase: use 'OR' instead of '${r[1]}'`);
        }
      });
      
      return {
        type: 'boolean',
        operator: 'OR',
        clauses: [first, ...rest.map(r => r[3])]
      };
    }

AndExpression
  = first:ImplicitOrTerm rest:(__ "AND"i __ ImplicitOrTerm)* {
      if (rest.length === 0) return first;
      
      // Check for case-sensitive AND
      rest.forEach(r => {
        if (r[1] !== 'AND') {
          error(`Boolean operator must be uppercase: use 'AND' instead of '${r[1]}'`);
        }
      });
      
      return {
        type: 'boolean',
        operator: 'AND',
        clauses: [first, ...rest.map(r => r[3])]
      };
    }

ImplicitOrTerm
  = first:NotExpression rest:(__ !("AND"i / "OR"i) NotExpression)* {
      if (rest.length === 0) return first;
      
      // Multiple terms without explicit operators = implicit OR
      return {
        type: 'boolean',
        operator: 'OR',
        clauses: [first, ...rest.map(r => r[2])]
      };
    }

NotExpression
  = not:"NOT"i __ expr:PrimaryExpression {
      // Check for case-sensitive NOT
      if (not !== 'NOT') {
        error(`Boolean operator must be uppercase: use 'NOT' instead of '${not}'`);
      }
      return {
        type: 'not',
        expression: expr
      };
    }
  / PrimaryExpression

PrimaryExpression
  = "(" __ expr:Expression __ ")" {
      return expr;
    }
  / ExistenceExpression
  / RangeExpression
  / FieldExpression
  / RegexExpression
  / PhraseExpression
  / TermExpression

// ============================================================================
// Field Queries
// ============================================================================

FieldExpression
  = field:FieldName __ (":" / "=") __ value:FieldValue {
      return {
        type: 'field',
        field: field,
        value: value
      };
    }

FieldName
  = ExistenceField
  / Identifier

FieldValue
  = "(" __ expr:Expression __ ")" {
      return {
        type: 'group',
        expression: expr
      };
    }
  / RangeValue
  / RegexLiteral
  / QuotedString
  / FieldTermExpression

// ============================================================================
// Existence Queries
// ============================================================================

ExistenceExpression
  = "_exists_" __ ":" __ field:FieldName {
      return {
        type: 'exists',
        field: field
      };
    }
  / "NOT" __ "_exists_" __ ":" __ field:FieldName {
      return {
        type: 'not',
        expression: {
          type: 'exists',
          field: field
        }
      };
    }

ExistenceField
  = "_exists_" {
      return "_exists_";
    }

// ============================================================================
// Range Queries
// ============================================================================

RangeExpression
  = field:FieldName __ ":" __ range:RangeValue {
      return {
        type: 'field',
        field: field,
        value: range
      };
    }

RangeValue
  = BoundedRange
  / UnboundedRange
  / CompoundUnboundedRange

BoundedRange
  = open:RangeBracketOpen __ from:RangeEndpoint __ "TO"i __ to:RangeEndpoint __ close:RangeBracketClose {
      return {
        type: 'range',
        from: from,
        to: to,
        inclusive_from: open === '[',
        inclusive_to: close === ']'
      };
    }

UnboundedRange
  = op:ComparisonOperator value:RangeEndpoint {
      return {
        type: 'unbounded_range',
        operator: op,
        value: value
      };
    }

CompoundUnboundedRange
  = "(" __ first:UnboundedRange __ "AND" __ second:UnboundedRange __ ")" {
      return {
        type: 'compound_range',
        conditions: [first, second]
      };
    }

ComparisonOperator
  = ">=" { return '>='; }
  / "<=" { return '<='; }
  / ">"  { return '>'; }
  / "<"  { return '<'; }

RangeBracketOpen
  = open:"[" { return open; }
  / open:"{" { return open; }

RangeBracketClose
  = close:"]" { return close; }
  / close:"}" { return close; }

RangeEndpoint
  = QuotedDateTime
  / RelativeTime
  / Number
  / "*"     { return { type: 'wildcard', value: '*' }; }
  / TermCharacters

QuotedDateTime
  = '"' datetime:DateTime '"' {
      return {
        type: 'datetime',
        value: datetime
      };
    }

DateTime
  = date:DatePart [ T] time:TimePart {
      return date + ' ' + time;
    }
  / date:ISODateTime {
      return date;
    }

DatePart
  = year:([0-9] [0-9] [0-9] [0-9]) "-" month:([0-9] [0-9]) "-" day:([0-9] [0-9]) {
      return year.join('') + '-' + month.join('') + '-' + day.join('');
    }

TimePart
  = hour:([0-9] [0-9]) ":" minute:([0-9] [0-9]) ":" second:([0-9] [0-9]) ms:("." [0-9]+)? {
      return hour.join('') + ':' + minute.join('') + ':' + second.join('') + (ms ? ms.join('') : '');
    }

ISODateTime
  = year:([0-9] [0-9] [0-9] [0-9]) "-" month:([0-9] [0-9]) "-" day:([0-9] [0-9]) 
    "T" hour:([0-9] [0-9]) ":" minute:([0-9] [0-9]) ":" second:([0-9] [0-9]) 
    ms:("." [0-9]+)? tz:Timezone? {
      return year.join('') + '-' + month.join('') + '-' + day.join('') + 
             'T' + hour.join('') + ':' + minute.join('') + ':' + second.join('') + 
             (ms ? ms.join('') : '') + (tz || '');
    }

Timezone
  = "Z" { return 'Z'; }
  / sign:[+-] hour:([0-9] [0-9]) ":" minute:([0-9] [0-9]) {
      return sign + hour.join('') + ':' + minute.join('');
    }

RelativeTime
  = "now" offset:TimeOffset? {
      return {
        type: 'relative_time',
        base: 'now',
        offset: offset
      };
    }

TimeOffset
  = op:[+-] num:Integer unit:TimeUnit {
      return {
        operator: op,
        value: parseInt(num),
        unit: unit
      };
    }

TimeUnit
  = "s" { return 's'; }
  / "m" { return 'm'; }
  / "h" { return 'h'; }
  / "d" { return 'd'; }
  / "w" { return 'w'; }

// ============================================================================
// Terms and Literals
// ============================================================================

FieldTermExpression
  = chars:FieldValueCharacter+ fuzzy:("~" Integer?)? {
      const term = chars.join('');
      
      // Check if it's a fuzzy search
      if (fuzzy) {
        return {
          type: 'fuzzy',
          term: term,
          distance: fuzzy[1] ? parseInt(fuzzy[1]) : 2
        };
      }
      
      // Check if it contains wildcards
      if (term.includes('*') || term.includes('?')) {
        return {
          type: 'wildcard',
          pattern: term
        };
      }
      
      // Regular term - just return the value directly for exact match
      return term;
    }

TermExpression
  = term:(WildcardCharacters / TermCharacters) fuzzy:("~" Integer?)? {
      // Check if it's a fuzzy search
      if (fuzzy) {
        return {
          type: 'fuzzy',
          term: term,
          distance: fuzzy[1] ? parseInt(fuzzy[1]) : 2
        };
      }
      
      // Check if it contains wildcards
      if (term.includes('*') || term.includes('?')) {
        return {
          type: 'wildcard',
          pattern: term
        };
      }
      
      // Regular term
      return {
        type: 'term',
        value: term
      };
    }

PhraseExpression
  = QuotedString

QuotedString
  = '"' chars:DoubleQuotedCharacter* '"' proximity:ProximityModifier? {
      if (proximity) {
        return {
          type: 'proximity',
          phrase: chars.join(''),
          distance: proximity
        };
      }
      return {
        type: 'phrase',
        value: chars.join('')
      };
    }
  / "'" chars:SingleQuotedCharacter* "'" {
      return {
        type: 'phrase',
        value: chars.join('')
      };
    }

ProximityModifier
  = "~" distance:Integer {
      return parseInt(distance);
    }

RegexExpression
  = RegexLiteral

RegexLiteral
  = "/" pattern:RegexCharacter+ "/" {
      return {
        type: 'regex',
        pattern: pattern.join('')
      };
    }

// ============================================================================
// Character Classes
// ============================================================================

TermCharacters
  = chars:TermCharacter+ {
      return chars.join('');
    }

WildcardCharacters
  = chars:WildcardCharacter+ {
      return chars.join('');
    }

FieldValueCharacter
  = EscapedCharacter
  / "*" { return '*'; }
  / "?" { return '?'; }
  / !Whitespace !"(" !")" !"[" !"]" !"{" !"}" char:. {
      return char;
    }

TermCharacter
  = !ReservedCharacter !Whitespace char:. {
      return char;
    }
  / EscapedCharacter

WildcardCharacter
  = "*" { return '*'; }
  / "?" { return '?'; }
  / TermCharacter

DoubleQuotedCharacter
  = '\\"' { return '"'; }
  / !'"' char:. { return char; }

SingleQuotedCharacter
  = "\\'" { return "'"; }
  / !"'" char:. { return char; }

RegexCharacter
  = "\\/" { return '/'; }
  / !"/" char:. { return char; }

EscapedCharacter
  = "\\" char:EscapableCharacter {
      return char;
    }

EscapableCharacter
  = "&" / "|" / ":" / "\\" / "/" / "+" / "-" / "!" / "(" / ")" / "{" / "}" / "[" / "]" / "^" / '"' / "~" / "*" / "?"

ReservedCharacter
  = ":" / "(" / ")" / "[" / "]" / "{" / "}" / '"' / "/" / ("~" !Integer)
  / " AND " / " OR " / " NOT "

// ============================================================================
// Basic Types
// ============================================================================

Identifier
  = first:IdentifierStart rest:IdentifierPart* {
      return first + rest.join('');
    }

IdentifierStart
  = [a-zA-Z_]

IdentifierPart
  = [a-zA-Z0-9_.-]

Number
  = Float
  / Integer

Float
  = digits:Integer "." decimals:[0-9]+ {
      return parseFloat(digits + '.' + decimals.join(''));
    }

Integer
  = digits:[0-9]+ {
      return digits.join('');
    }

// ============================================================================
// Whitespace
// ============================================================================

__ "whitespace"
  = Whitespace*

Whitespace
  = [ \t\n\r]