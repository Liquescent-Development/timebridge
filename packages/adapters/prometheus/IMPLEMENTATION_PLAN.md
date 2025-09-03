# PromQL Parser Implementation Plan

## 🎉 Implementation Status: COMPLETED

**All 7 phases have been successfully completed!**

- ✅ **Phase 1**: Core Grammar Setup - COMPLETE
- ✅ **Phase 2**: Operators and Expressions - COMPLETE  
- ✅ **Phase 3**: Functions and Aggregations - COMPLETE
- ✅ **Phase 4**: Advanced Features - COMPLETE
- ✅ **Phase 5**: Parser Implementation - COMPLETE
- ✅ **Phase 6**: Testing - COMPLETE
- ✅ **Phase 7**: Integration - COMPLETE

## Overview

Implement a comprehensive PromQL parser using Peggy grammar generator for the Prometheus adapter, similar to the InfluxQL and Graylog parsers.

## Phase 1: Core Grammar Setup

### 1.1 Create Grammar Structure
- [x] Create `grammar/promql.peggy` file
- [x] Define basic tokens (numbers, strings, identifiers)
- [x] Implement duration parsing (5m, 1h, etc.)
- [x] Add whitespace and comment handling

### 1.2 Implement Selectors
- [x] Instant vector selectors (metric_name{label="value"})
- [x] Range vector selectors (metric_name[5m])
- [x] Label matchers (=, !=, =~, !~)
- [x] Time modifiers (offset, @ modifier)

## Phase 2: Operators and Expressions

### 2.1 Binary Operators
- [x] Arithmetic operators (+, -, *, /, %, ^)
- [x] Comparison operators (==, !=, <, >, <=, >=)
- [x] Logical operators (and, or, unless)
- [x] Operator precedence rules

### 2.2 Vector Matching
- [x] One-to-one matching (on, ignoring)
- [x] One-to-many matching (group_left, group_right)
- [x] Bool modifier for comparisons

## Phase 3: Functions and Aggregations

### 3.1 Aggregation Operators
- [x] Basic aggregations (sum, avg, min, max, count)
- [x] Advanced aggregations (quantile, stddev, topk, bottomk)
- [x] By/without label modifiers

### 3.2 Built-in Functions
- [x] Rate functions (rate, irate, increase, delta)
- [x] Math functions (abs, ceil, floor, round, sqrt, etc.)
- [x] Time functions (time, timestamp, day_of_week, etc.)
- [x] Label functions (label_join, label_replace)
- [x] Histogram functions

## Phase 4: Advanced Features

### 4.1 Subqueries
- [x] Subquery syntax [range:resolution]
- [x] Nested subqueries

### 4.2 Special Constructs
- [x] Native histogram literals
- [x] Special functions (vector, scalar)
- [x] Start() and end() functions

## Phase 5: Parser Implementation

### 5.1 Create Parser Class
```typescript
// src/promql-parser.ts
export class PromQLParser {
  parse(query: string): ParseResult
  validate(query: string): ValidationResult
  stringify(ast: PromQLAST): string
}
```
✅ **COMPLETED**

### 5.2 Validation Features
- [x] Syntax validation
- [x] Type checking (scalar vs vector vs matrix)
- [x] Function argument validation
- [x] Duration format validation
- [x] Label name validation

### 5.3 Error Handling
- [x] Detailed error messages with position
- [x] Suggestions for common mistakes
- [x] Warning for deprecated syntax

## Phase 6: Testing

### 6.1 Unit Tests
- [x] Basic expression parsing
- [x] Vector selector tests
- [x] Operator precedence tests
- [x] Function parsing tests
- [x] Error case tests

### 6.2 Integration Tests
- [x] Complex query parsing
- [x] AST to string round-trip
- [x] Validation tests
- [x] Real-world query examples

## Phase 7: Integration

### 7.1 Adapter Integration
- [x] Update PrometheusAdapter to use parser
- [x] Add query validation in adapter
- [x] Update existing tests

### 7.2 Build Configuration
- [x] Add Peggy dependency
- [x] Add generate-parser script
- [x] Update build process

## Implementation Notes

### Key Differences from InfluxQL/Graylog

1. **Type System**: PromQL has strict typing (scalar/vector/matrix)
2. **Vector Matching**: Complex matching rules for vector operations
3. **Time Handling**: Special @ modifier and offset syntax
4. **Functions**: Extensive built-in function library
5. **Aggregations**: Sophisticated grouping with by/without

### Parser Design Decisions

1. **AST Structure**: Follow Prometheus official AST design
2. **Validation**: Implement type checking during parsing
3. **Error Recovery**: Provide helpful suggestions
4. **Performance**: Optimize for common query patterns

### Testing Strategy

1. Port test cases from official Prometheus parser
2. Add edge cases specific to our use cases
3. Ensure compatibility with existing adapter behavior
4. Test performance with complex queries

## Files to Create

```
packages/adapters/prometheus/
├── grammar/
│   └── promql.peggy          # Peggy grammar definition
├── src/
│   ├── generated/
│   │   └── promql-parser.js  # Generated parser
│   ├── promql-parser.ts      # Parser wrapper class
│   └── promql-parser.test.ts # Parser tests
├── promql-spec.md            # Language specification
└── package.json              # Updated with build scripts
```

## Success Criteria

1. ✅ All test cases from official parser pass
2. ✅ Parser validates queries correctly
3. ✅ AST can be stringified back to valid PromQL
4. ✅ Integration with PrometheusAdapter works
5. ✅ Performance comparable to official parser
6. ✅ Helpful error messages and suggestions

## Reference Implementation

Study the official Prometheus parser at:
- `/workspace/tempdocs/promql/parser/`
- Focus on `parse_test.go` for test cases
- Review `ast.go` for AST structure
- Check `functions.go` for function definitions

## Timeline Estimate

- Phase 1-2: Core grammar (2-3 hours)
- Phase 3-4: Functions and advanced features (2-3 hours)
- Phase 5: Parser implementation (1-2 hours)
- Phase 6: Testing (2-3 hours)
- Phase 7: Integration (1 hour)

Total: 8-12 hours of implementation time