/**
 * InfluxQL Parser
 * Provides validation and parsing for InfluxQL queries using Peggy grammar
 */

// Removed unused import

// Type definitions for parsed InfluxQL AST
export interface InfluxQLAST {
  type: string;
  [key: string]: any;
}

export interface ParseResult {
  valid: boolean;
  ast?: InfluxQLAST;
  error?: string;
  suggestions?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}

export interface ValidationError {
  type: 'SYNTAX' | 'SEMANTIC' | 'IDENTIFIER' | 'FUNCTION' | 'DURATION';
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

export interface ValidationWarning {
  type: 'PERFORMANCE' | 'DEPRECATED' | 'BEST_PRACTICE' | 'UNKNOWN_FIELD' | 'UNKNOWN_TAG' | 'SCHEMA';
  message: string;
  suggestion?: string;
}

// Type guard for the generated parser
interface GeneratedInfluxQLParser {
  parse(input: string): InfluxQLAST;
}

export class InfluxQLParser {
  private parser: GeneratedInfluxQLParser | null = null;
  
  // InfluxQL aggregate functions from the spec
  private readonly AGGREGATE_FUNCTIONS = new Set([
    'COUNT', 'DISTINCT', 'INTEGRAL', 'MEAN', 'MEDIAN', 'MODE', 'SPREAD',
    'STDDEV', 'SUM', 'FIRST', 'LAST', 'MAX', 'MIN', 'PERCENTILE', 'SAMPLE',
    'TOP', 'BOTTOM', 'DERIVATIVE', 'DIFFERENCE', 'NON_NEGATIVE_DERIVATIVE',
    'MOVING_AVERAGE', 'CUMULATIVE_SUM', 'ELAPSED'
  ]);

  // InfluxQL keywords
  private readonly KEYWORDS = new Set([
    'ALL', 'ALTER', 'ANALYZE', 'ANY', 'AS', 'ASC', 'BEGIN', 'BY', 'CREATE',
    'CONTINUOUS', 'DATABASE', 'DATABASES', 'DEFAULT', 'DELETE', 'DESC',
    'DESTINATIONS', 'DIAGNOSTICS', 'DISTINCT', 'DROP', 'DURATION', 'END',
    'EVERY', 'EXPLAIN', 'FIELD', 'FOR', 'FROM', 'GRANT', 'GRANTS', 'GROUP',
    'GROUPS', 'IN', 'INF', 'INSERT', 'INTO', 'KEY', 'KEYS', 'KILL', 'LIMIT',
    'SHOW', 'MEASUREMENT', 'MEASUREMENTS', 'NAME', 'OFFSET', 'ON', 'ORDER',
    'PASSWORD', 'POLICY', 'POLICIES', 'PRIVILEGES', 'QUERIES', 'QUERY',
    'READ', 'REPLICATION', 'RESAMPLE', 'RETENTION', 'REVOKE', 'SELECT',
    'SERIES', 'SET', 'SHARD', 'SHARDS', 'SLIMIT', 'SOFFSET', 'STATS',
    'SUBSCRIPTION', 'SUBSCRIPTIONS', 'TAG', 'TO', 'USER', 'USERS', 'VALUES',
    'WHERE', 'WITH', 'WRITE'
  ]);

  // Valid duration units
  private readonly DURATION_UNITS = new Set(['u', 'µ', 'ms', 's', 'm', 'h', 'd', 'w']);

  constructor() {
    this.loadParser();
  }

  private loadParser(): void {
    try {
      // Try to load the generated parser
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.parser = require('./generated/influxql-parser.js') as GeneratedInfluxQLParser;
    } catch (error) {
      console.warn('InfluxQL parser not generated yet. Run npm run generate-influxql-parser');
      // Parser will be null, methods will use fallback validation
    }
  }

  /**
   * Parse an InfluxQL query and return the AST
   */
  parse(query: string): ParseResult {
    if (!query || query.trim().length === 0) {
      return {
        valid: false,
        error: 'Empty query'
      };
    }

    // Use Peggy parser if available
    if (this.parser) {
      try {
        const ast = this.parser.parse(query);
        return {
          valid: true,
          ast
        };
      } catch (error: any) {
        // Parse error from Peggy
        const parseError = error as {
          location?: { start: { line: number; column: number } };
          message: string;
        };
        
        return {
          valid: false,
          error: this.formatParseError(parseError),
          suggestions: this.getSuggestionsForError(query, parseError)
        };
      }
    }

    // Fallback to basic validation if parser not available
    return this.fallbackValidation(query);
  }

  /**
   * Validate an InfluxQL query
   */
  validate(query: string): ValidationResult {
    const parseResult = this.parse(query);
    
    if (!parseResult.valid) {
      let errorMessage = parseResult.error || 'Invalid query syntax';
      
      // Detect unclosed quotes/parentheses
      if (errorMessage.toLowerCase().includes('expected') && 
          errorMessage.toLowerCase().includes('but end of input found')) {
        if (query.split('"').length % 2 === 0) {
          errorMessage = "Unclosed double quote in query";
        } else if (query.split("'").length % 2 === 0) {
          errorMessage = "Unclosed single quote in query";
        } else {
          const openParen = (query.match(/\(/g) || []).length;
          const closeParen = (query.match(/\)/g) || []).length;
          if (openParen > closeParen) {
            errorMessage = "Unclosed parenthesis in query";
          }
        }
      }
      
      return {
        valid: false,
        errors: [{
          type: 'SYNTAX',
          message: errorMessage
        }]
      };
    }

    // Perform semantic validation on the AST
    if (parseResult.ast) {
      return this.validateSemantics(parseResult.ast);
    }

    return { valid: true };
  }

  /**
   * Validate query with detailed results
   */
  validateDetailed(query: string): ValidationResult {
    const result = this.validate(query);
    
    // Add performance warnings if applicable
    if (result.valid && query) {
      const perfWarnings = this.getPerformanceWarnings(query);
      if (perfWarnings.length > 0) {
        result.warnings = [...(result.warnings || []), ...perfWarnings];
      }
    }
    
    return result;
  }

  /**
   * Check if a query has a time constraint
   */
  hasTimeConstraint(query: string): boolean {
    const parseResult = this.parse(query);
    
    if (parseResult.valid && parseResult.ast) {
      return this.astHasTimeConstraint(parseResult.ast);
    }
    
    // Fallback to string checking
    const upperQuery = query.toUpperCase();
    return upperQuery.includes('TIME') && upperQuery.includes('WHERE');
  }

  /**
   * Add time constraint to a query
   */
  addTimeConstraint(query: string, duration: string): string {
    // First check if time constraint already exists
    if (this.hasTimeConstraint(query)) {
      return query; // Don't add duplicate time constraint
    }
    
    const parseResult = this.parse(query);
    
    if (parseResult.valid && parseResult.ast && parseResult.ast.type === 'SELECT') {
      // Modify AST and regenerate query
      const modifiedAst = this.addTimeConstraintToAST(parseResult.ast, duration);
      return this.generateQueryFromAST(modifiedAst);
    }
    
    // Fallback to string manipulation
    return this.fallbackAddTimeConstraint(query, duration);
  }

  /**
   * Get field names from a SELECT query
   */
  getSelectedFields(query: string): string[] {
    const parseResult = this.parse(query);
    
    if (parseResult.valid && parseResult.ast && parseResult.ast.type === 'SELECT') {
      return this.extractFieldsFromAST(parseResult.ast);
    }
    
    return [];
  }

  /**
   * Get measurement names from a query
   */
  getMeasurements(query: string): string[] {
    const parseResult = this.parse(query);
    
    if (parseResult.valid && parseResult.ast) {
      return this.extractMeasurementsFromAST(parseResult.ast);
    }
    
    return [];
  }

  /**
   * Validate identifier format (quoted vs unquoted)
   */
  validateIdentifier(identifier: string): boolean {
    // Unquoted: must start with letter or underscore, contain only alphanumeric and underscore
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
      return true;
    }
    
    // Quoted: must be surrounded by double quotes
    if (/^".*"$/.test(identifier)) {
      // Check for proper escaping of internal quotes
      const content = identifier.slice(1, -1);
      return !content.includes('"') || /\\"/g.test(content);
    }
    
    return false;
  }

  /**
   * Validate duration format
   */
  validateDuration(duration: string): boolean {
    // Duration must be number followed by unit
    const match = duration.match(/^(\d+)([a-zA-Zµ]+)$/);
    if (!match) return false;
    
    const [, , unit] = match;
    return this.DURATION_UNITS.has(unit);
  }

  // Private helper methods

  private formatParseError(error: any): string {
    let message = error.message || 'Unknown parse error';
    
    // Improve error messages for common issues
    if (message.includes('but end of input found')) {
      if (message.includes('Expected ")"')) {
        message = 'Unclosed parentheses - missing closing parenthesis';
      } else if (message.includes('Expected "\'"') || message.includes('Expected \'"\'')) {
        message = 'Unclosed quote - string literal not terminated';
      }
    } else if (message.includes('but "F" found') && message.includes('Expected "%", ")", "*"')) {
      message = 'Unclosed parentheses - expected closing parenthesis after function argument';
    }
    
    if (error.location) {
      return `Query parse error at line ${error.location.start.line}, column ${error.location.start.column}: ${message}`;
    }
    return message;
  }

  private getSuggestionsForError(query: string, error: any): string[] {
    const suggestions: string[] = [];
    const errorMessage = error.message?.toLowerCase() || '';
    
    if (errorMessage.includes('expected "select"')) {
      suggestions.push('Query should start with SELECT');
    }
    
    if (errorMessage.includes('expected "from"')) {
      suggestions.push('SELECT statement requires FROM clause');
    }
    
    if (errorMessage.includes('identifier')) {
      suggestions.push('Use double quotes for identifiers with special characters');
      suggestions.push('Example: SELECT "field-name" FROM "measurement-name"');
    }
    
    if (errorMessage.includes('string')) {
      suggestions.push('Use single quotes for string values');
      suggestions.push('Example: WHERE tag = \'value\'');
    }
    
    return suggestions;
  }

  private fallbackValidation(query: string): ParseResult {
    const upperQuery = query.toUpperCase();
    
    // Check for basic SELECT structure
    if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('SHOW') && 
        !upperQuery.startsWith('CREATE') && !upperQuery.startsWith('DROP') &&
        !upperQuery.startsWith('ALTER') && !upperQuery.startsWith('DELETE')) {
      return {
        valid: false,
        error: 'Query must start with SELECT, SHOW, CREATE, DROP, ALTER, or DELETE'
      };
    }
    
    // Check for balanced parentheses
    let parenCount = 0;
    for (const char of query) {
      if (char === '(') parenCount++;
      if (char === ')') parenCount--;
      if (parenCount < 0) {
        return {
          valid: false,
          error: 'Unbalanced parentheses'
        };
      }
    }
    
    if (parenCount !== 0) {
      return {
        valid: false,
        error: 'Unclosed parentheses'
      };
    }
    
    // Check for balanced quotes
    const singleQuotes = (query.match(/'/g) || []).length;
    const doubleQuotes = (query.match(/"/g) || []).length;
    
    if (singleQuotes % 2 !== 0) {
      return {
        valid: false,
        error: 'Unclosed single quote'
      };
    }
    
    if (doubleQuotes % 2 !== 0) {
      return {
        valid: false,
        error: 'Unclosed double quote'
      };
    }
    
    return { valid: true };
  }

  private validateSemantics(ast: InfluxQLAST): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    if (ast.type === 'SELECT') {
      // Validate field references
      if (ast.fields) {
        for (const field of ast.fields) {
          if (field.type === 'function' && !this.AGGREGATE_FUNCTIONS.has(field.name.toUpperCase())) {
            errors.push({
              type: 'FUNCTION',
              message: `Unknown aggregate function: ${field.name}`,
              suggestion: `Valid functions: ${Array.from(this.AGGREGATE_FUNCTIONS).join(', ')}`
            });
          }
        }
      }
      
      // Validate GROUP BY with aggregate functions
      const hasAggregates = ast.fields?.some((f: any) => f.type === 'function');
      const hasGroupBy = !!ast.groupBy;
      
      if (hasAggregates && !hasGroupBy) {
        warnings.push({
          type: 'BEST_PRACTICE',
          message: 'Aggregate functions without GROUP BY will aggregate all data',
          suggestion: 'Consider adding GROUP BY time() for time-series aggregation'
        });
      }
    }
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  private getPerformanceWarnings(query: string): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];
    const upperQuery = query.toUpperCase();
    
    // Warn about SELECT * 
    if (upperQuery.includes('SELECT *') || upperQuery.includes('SELECT*')) {
      warnings.push({
        type: 'PERFORMANCE',
        message: 'SELECT * may return excessive data',
        suggestion: 'Specify only the fields you need'
      });
    }
    
    // Warn about missing time constraints
    if (!upperQuery.includes('WHERE') || !upperQuery.includes('TIME')) {
      warnings.push({
        type: 'PERFORMANCE',
        message: 'Query lacks time constraint',
        suggestion: 'Add WHERE time > now() - <duration> to limit data'
      });
    }
    
    // Warn about missing LIMIT
    if (!upperQuery.includes('LIMIT')) {
      warnings.push({
        type: 'BEST_PRACTICE',
        message: 'Consider adding LIMIT to prevent excessive results',
        suggestion: 'Add LIMIT <n> to restrict result count'
      });
    }
    
    return warnings;
  }

  private astHasTimeConstraint(ast: InfluxQLAST): boolean {
    if (ast.where) {
      return this.conditionHasTimeField(ast.where);
    }
    return false;
  }

  private conditionHasTimeField(condition: any): boolean {
    if (condition.type === 'comparison') {
      // Check if either left or right side references 'time'
      if (condition.left?.type === 'identifier' && condition.left.name === 'time') {
        return true;
      }
      if (condition.right?.type === 'identifier' && condition.right.name === 'time') {
        return true;
      }
      // Also check for time in binary expressions like "now() - 1h"
      if (condition.left?.type === 'binary' || condition.right?.type === 'binary') {
        return this.expressionHasTime(condition.left) || this.expressionHasTime(condition.right);
      }
    }
    
    if (condition.type === 'and' || condition.type === 'or') {
      return this.conditionHasTimeField(condition.left) || 
             this.conditionHasTimeField(condition.right);
    }
    
    if (condition.type === 'not') {
      return this.conditionHasTimeField(condition.condition);
    }
    
    return false;
  }
  
  private expressionHasTime(expr: any): boolean {
    if (!expr) return false;
    
    if (expr.type === 'identifier' && expr.name === 'time') {
      return true;
    }
    
    if (expr.type === 'binary') {
      return this.expressionHasTime(expr.left) || this.expressionHasTime(expr.right);
    }
    
    return false;
  }

  private addTimeConstraintToAST(ast: InfluxQLAST, duration: string): InfluxQLAST {
    const timeCondition = {
      type: 'comparison',
      operator: '>',
      left: { type: 'identifier', name: 'time' },
      right: {
        type: 'binary',
        operator: '-',
        left: { type: 'function', name: 'now' },
        right: { type: 'duration', value: this.parseDuration(duration) }
      }
    };
    
    if (ast.where) {
      // Add to existing WHERE clause with AND
      ast.where = {
        type: 'and',
        left: ast.where,
        right: timeCondition
      };
    } else {
      // Create new WHERE clause
      ast.where = timeCondition;
    }
    
    return ast;
  }

  private parseDuration(duration: string): { value: number; unit: string } {
    const match = duration.match(/^(\d+)([a-zA-Zµ]+)$/);
    if (match) {
      return {
        value: parseInt(match[1], 10),
        unit: match[2]
      };
    }
    // Default to 5 minutes if parsing fails
    return { value: 5, unit: 'm' };
  }

  private generateQueryFromAST(ast: InfluxQLAST): string {
    let query = 'SELECT ';
    
    // Fields
    if (ast.fields) {
      query += ast.fields.map((f: any) => {
        if (f.type === 'wildcard') return '*';
        if (f.type === 'field') return f.expression?.name || f.expression;
        if (f.type === 'function') return `${f.name}(${f.argument?.name || '*'})`;
        return f;
      }).join(', ');
    }
    
    // INTO clause
    if (ast.into) {
      query += ' INTO ';
      if (ast.into.type === 'back_ref') {
        query += ast.into.retentionPolicy ? `"${ast.into.retentionPolicy}".:MEASUREMENT` : ':MEASUREMENT';
      } else {
        query += ast.into.retentionPolicy 
          ? `"${ast.into.retentionPolicy}"."${ast.into.measurement}"`
          : `"${ast.into.measurement}"`;
      }
    }
    
    // FROM clause
    query += ' FROM ';
    if (ast.sources) {
      query += ast.sources.map((s: any) => {
        if (s.type === 'regex') return `/${s.pattern}/`;
        if (s.name?.measurement) return `"${s.name.measurement}"`;
        return s.name || s;
      }).join(', ');
    }
    
    // WHERE clause
    if (ast.where) {
      query += ' WHERE ' + this.conditionToString(ast.where);
    }
    
    // GROUP BY clause
    if (ast.groupBy) {
      query += ' GROUP BY ';
      if (ast.groupBy.dimensions) {
        query += ast.groupBy.dimensions.map((d: any) => {
          if (d.type === 'time') return `time(${d.interval.value}${d.interval.unit})`;
          if (d.type === 'wildcard') return '*';
          return d.name;
        }).join(', ');
      }
      if (ast.groupBy.fill) {
        query += ` fill(${ast.groupBy.fill})`;
      }
    }
    
    // ORDER BY
    if (ast.orderBy) {
      query += ' ORDER BY ' + ast.orderBy.map((s: any) => 
        `${s.field} ${s.direction}`
      ).join(', ');
    }
    
    // LIMIT
    if (ast.limit) query += ` LIMIT ${ast.limit}`;
    
    // OFFSET
    if (ast.offset) query += ` OFFSET ${ast.offset}`;
    
    return query;
  }
  
  private conditionToString(condition: any): string {
    if (condition.type === 'comparison') {
      const left = this.expressionToString(condition.left);
      const right = this.expressionToString(condition.right);
      return `${left} ${condition.operator} ${right}`;
    }
    
    if (condition.type === 'and') {
      return `${this.conditionToString(condition.left)} AND ${this.conditionToString(condition.right)}`;
    }
    
    if (condition.type === 'or') {
      return `${this.conditionToString(condition.left)} OR ${this.conditionToString(condition.right)}`;
    }
    
    if (condition.type === 'not') {
      return `NOT ${this.conditionToString(condition.condition)}`;
    }
    
    return '';
  }
  
  private expressionToString(expr: any): string {
    if (!expr) return '';
    
    if (expr.type === 'identifier') return expr.name;
    if (expr.type === 'string') return `'${expr.value}'`;
    if (expr.type === 'number') return expr.value.toString();
    if (expr.type === 'duration') return `${expr.value.value}${expr.value.unit}`;
    
    if (expr.type === 'function') {
      if (expr.name === 'now') return 'now()';
      return `${expr.name}()`;
    }
    
    if (expr.type === 'binary') {
      const left = this.expressionToString(expr.left);
      const right = this.expressionToString(expr.right);
      return `${left} ${expr.operator} ${right}`;
    }
    
    return JSON.stringify(expr);
  }

  private fallbackAddTimeConstraint(query: string, duration: string): string {
    const upperQuery = query.toUpperCase();
    
    if (upperQuery.includes('WHERE')) {
      // Add to existing WHERE clause
      const whereIndex = upperQuery.indexOf('WHERE');
      const beforeWhere = query.substring(0, whereIndex + 5);
      const afterWhere = query.substring(whereIndex + 5);
      
      // Check if time constraint already exists
      if (upperQuery.includes('TIME')) {
        return query; // Already has time constraint
      }
      
      return `${beforeWhere} time > now() - ${duration} AND${afterWhere}`;
    } else {
      // Add new WHERE clause
      const fromMatch = query.match(/FROM\s+[^\s]+/i);
      if (fromMatch) {
        const afterFrom = fromMatch.index! + fromMatch[0].length;
        return query.slice(0, afterFrom) + ` WHERE time > now() - ${duration}` + query.slice(afterFrom);
      }
    }
    
    return query;
  }

  private extractFieldsFromAST(ast: InfluxQLAST): string[] {
    const fields: string[] = [];
    
    if (ast.fields) {
      for (const field of ast.fields) {
        if (field.type === 'wildcard') {
          fields.push('*');
        } else if (field.type === 'field' && field.expression?.type === 'identifier') {
          fields.push(field.expression.name);
        } else if (field.type === 'function') {
          fields.push(`${field.name}(${field.argument?.name || '*'})`);
        }
      }
    }
    
    return fields;
  }

  private extractMeasurementsFromAST(ast: InfluxQLAST): string[] {
    const measurements: string[] = [];
    
    if (ast.sources) {
      for (const source of ast.sources) {
        if (source.type === 'measurement') {
          // Handle both source.name.measurement and source.name structures
          if (source.name?.measurement) {
            measurements.push(source.name.measurement);
          } else if (typeof source.name === 'string') {
            measurements.push(source.name);
          } else if (source.measurement) {
            measurements.push(source.measurement);
          }
        } else if (source.type === 'regex') {
          measurements.push(`/${source.pattern}/`);
        }
      }
    }
    
    return measurements;
  }

  // Phase 2: Advanced Query Features

  /**
   * Check if query contains aggregate functions
   */
  hasAggregateFunction(query: string): boolean {
    const result = this.parse(query);
    if (!result.valid || !result.ast) return false;
    
    return this.astContainsAggregates(result.ast);
  }

  /**
   * Extract aggregate functions from query
   */
  getAggregateFunctions(query: string): string[] {
    const result = this.parse(query);
    if (!result.valid || !result.ast) return [];
    
    return this.extractAggregateFunctions(result.ast);
  }

  /**
   * Extract WHERE clause conditions
   */
  getWhereConditions(query: string): any[] {
    const result = this.parse(query);
    if (!result.valid || !result.ast || !result.ast.where) return [];
    
    return this.extractConditions(result.ast.where);
  }

  /**
   * Extract GROUP BY fields
   */
  getGroupByFields(query: string): string[] {
    const result = this.parse(query);
    if (!result.valid || !result.ast || !result.ast.groupBy) return [];
    
    const fields: string[] = [];
    const groupBy = result.ast.groupBy;
    
    if (groupBy.dimensions) {
      for (const dim of groupBy.dimensions) {
        if (dim.type === 'tag' || dim.type === 'identifier') {
          fields.push(dim.name);
        } else if (dim.type === 'time') {
          const interval = dim.interval;
          fields.push(`time(${interval?.value || ''}${interval?.unit || ''})`);
        } else if (dim.type === 'wildcard') {
          fields.push('*');
        }
      }
    }
    
    return fields;
  }

  /**
   * Get LIMIT value from AST
   */
  getLimit(ast: InfluxQLAST): number | null {
    if (!ast || ast.limit === undefined || ast.limit === null) return null;
    return typeof ast.limit === 'number' ? ast.limit : (ast.limit.value || null);
  }

  /**
   * Get OFFSET value from AST
   */
  getOffset(ast: InfluxQLAST): number | null {
    if (!ast || ast.offset === undefined || ast.offset === null) return null;
    return typeof ast.offset === 'number' ? ast.offset : (ast.offset.value || null);
  }

  /**
   * Check if query contains regex patterns
   */
  hasRegexPattern(query: string): boolean {
    const result = this.parse(query);
    if (!result.valid || !result.ast) return false;
    
    return this.astContainsRegex(result.ast);
  }

  // Helper methods for Phase 2 features

  private astContainsAggregates(ast: any): boolean {
    if (!ast) return false;
    
    // Check fields for aggregate functions
    if (ast.fields) {
      for (const field of ast.fields) {
        if (field.type === 'function' && this.isAggregateFunction(field.name)) {
          return true;
        }
        if (field.expression && this.expressionContainsAggregate(field.expression)) {
          return true;
        }
      }
    }
    
    return false;
  }

  private extractAggregateFunctions(ast: any): string[] {
    const functions: string[] = [];
    
    if (!ast || !ast.fields) return functions;
    
    for (const field of ast.fields) {
      if (field.type === 'function' && this.isAggregateFunction(field.name)) {
        functions.push(field.name.toUpperCase());
      }
      if (field.expression) {
        this.extractAggregateFunctionsFromExpression(field.expression, functions);
      }
    }
    
    return [...new Set(functions)]; // Remove duplicates
  }

  private extractAggregateFunctionsFromExpression(expr: any, functions: string[]): void {
    if (!expr) return;
    
    if (expr.type === 'function' && this.isAggregateFunction(expr.name)) {
      functions.push(expr.name.toUpperCase());
    }
    
    if (expr.left) this.extractAggregateFunctionsFromExpression(expr.left, functions);
    if (expr.right) this.extractAggregateFunctionsFromExpression(expr.right, functions);
    if (expr.arguments) {
      for (const arg of expr.arguments) {
        this.extractAggregateFunctionsFromExpression(arg, functions);
      }
    }
  }

  private expressionContainsAggregate(expr: any): boolean {
    if (!expr) return false;
    
    if (expr.type === 'function' && this.isAggregateFunction(expr.name)) {
      return true;
    }
    
    if (expr.left && this.expressionContainsAggregate(expr.left)) return true;
    if (expr.right && this.expressionContainsAggregate(expr.right)) return true;
    if (expr.arguments) {
      for (const arg of expr.arguments) {
        if (this.expressionContainsAggregate(arg)) return true;
      }
    }
    
    return false;
  }

  private isAggregateFunction(name: string): boolean {
    if (!name) return false;
    return this.AGGREGATE_FUNCTIONS.has(name.toUpperCase());
  }

  private extractConditions(whereClause: any): any[] {
    const conditions: any[] = [];
    
    if (!whereClause) return conditions;
    
    // Recursively extract conditions
    this.extractConditionsRecursive(whereClause, conditions);
    
    return conditions;
  }

  private extractConditionsRecursive(node: any, conditions: any[]): void {
    if (!node) return;
    
    if (node.type === 'comparison' || node.type === 'in' || node.type === 'regex') {
      conditions.push(node);
    } else if (node.type === 'and' || node.type === 'or') {
      this.extractConditionsRecursive(node.left, conditions);
      this.extractConditionsRecursive(node.right, conditions);
    } else if (node.type === 'not') {
      this.extractConditionsRecursive(node.condition, conditions);
    } else if (node.type === 'parentheses') {
      this.extractConditionsRecursive(node.expression, conditions);
    }
  }

  private astContainsRegex(ast: any): boolean {
    if (!ast) return false;
    
    // Check sources for regex patterns
    if (ast.sources) {
      for (const source of ast.sources) {
        if (source.type === 'regex') return true;
      }
    }
    
    // Check WHERE clause for regex operators
    if (ast.where) {
      return this.conditionContainsRegex(ast.where);
    }
    
    return false;
  }

  private conditionContainsRegex(condition: any): boolean {
    if (!condition) return false;
    
    if (condition.type === 'regex') return true;
    
    if (condition.type === 'and' || condition.type === 'or') {
      return this.conditionContainsRegex(condition.left) || 
             this.conditionContainsRegex(condition.right);
    }
    
    if (condition.type === 'not') {
      return this.conditionContainsRegex(condition.condition);
    }
    
    if (condition.type === 'parentheses') {
      return this.conditionContainsRegex(condition.expression);
    }
    
    return false;
  }

  // Phase 3: Statement Types & Features

  /**
   * Get the type of InfluxQL statement
   */
  getStatementType(query: string): string | null {
    const trimmed = query.trim().toUpperCase();
    
    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('SHOW')) return 'SHOW';
    if (trimmed.startsWith('CREATE')) return 'CREATE';
    if (trimmed.startsWith('ALTER')) return 'ALTER';
    if (trimmed.startsWith('DROP')) return 'DROP';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('GRANT')) return 'GRANT';
    if (trimmed.startsWith('REVOKE')) return 'REVOKE';
    
    return null;
  }

  /**
   * Check if query contains a subquery
   */
  hasSubquery(query: string): boolean {
    const result = this.parse(query);
    if (!result.valid || !result.ast) return false;
    
    return this.astContainsSubquery(result.ast);
  }

  /**
   * Extract continuous query details
   */
  getContinuousQueryDetails(query: string): { name: string; database: string } | null {
    const match = query.match(/CREATE\s+CONTINUOUS\s+QUERY\s+(\w+)\s+ON\s+(\w+)/i);
    if (match) {
      return {
        name: match[1],
        database: match[2]
      };
    }
    return null;
  }

  /**
   * Get INTO target from AST
   */
  getIntoTarget(ast: InfluxQLAST): string | null {
    if (!ast || !ast.into) return null;
    
    if (typeof ast.into === 'string') {
      return ast.into;
    }
    
    if (ast.into.measurement) {
      return ast.into.measurement;
    }
    
    if (ast.into.name) {
      return ast.into.name;
    }
    
    return null;
  }

  /**
   * Get fill option from AST
   */
  getFillOption(ast: InfluxQLAST): string | number | null {
    if (!ast || !ast.groupBy || !ast.groupBy.fill) return null;
    
    return ast.groupBy.fill;
  }

  /**
   * Check if AST contains subqueries
   */
  private astContainsSubquery(ast: any): boolean {
    if (!ast) return false;
    
    // Check sources for subqueries
    if (ast.sources) {
      for (const source of ast.sources) {
        if (source.type === 'subquery') return true;
      }
    }
    
    // Check for nested SELECT in FROM
    if (ast.from && typeof ast.from === 'object' && ast.from.type === 'SELECT') {
      return true;
    }
    
    return false;
  }

  /**
   * Validate time literal format (RFC3339)
   */
  validateTimeLiteral(timeLiteral: string): boolean {
    // RFC3339 format: YYYY-MM-DDTHH:mm:ss.sssZ or ±HH:MM
    const rfc3339Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
    
    // Unix timestamp in various units
    const timestampRegex = /^\d+([mu]?s)?$/;
    
    return rfc3339Regex.test(timeLiteral) || timestampRegex.test(timeLiteral);
  }

  /**
   * Parse retention policy from query
   */
  parseRetentionPolicy(query: string): { name: string; database: string; duration?: string; replication?: number } | null {
    const createMatch = query.match(/CREATE\s+RETENTION\s+POLICY\s+(\w+)\s+ON\s+(\w+)\s+DURATION\s+(\w+)\s+REPLICATION\s+(\d+)/i);
    if (createMatch) {
      return {
        name: createMatch[1],
        database: createMatch[2],
        duration: createMatch[3],
        replication: parseInt(createMatch[4])
      };
    }
    
    const alterMatch = query.match(/ALTER\s+RETENTION\s+POLICY\s+(\w+)\s+ON\s+(\w+)/i);
    if (alterMatch) {
      return {
        name: alterMatch[1],
        database: alterMatch[2]
      };
    }
    
    return null;
  }

  // Phase 4: Production Readiness Features

  private schema: InfluxQLSchema | null = null;

  /**
   * Set schema for validation
   */
  setSchema(schema: InfluxQLSchema): void {
    this.schema = schema;
  }

  /**
   * Clear schema
   */
  clearSchema(): void {
    this.schema = null;
  }

  /**
   * Validate query with schema awareness
   */
  validateWithSchema(query: string): DetailedValidationResult {
    const baseResult = this.validateDetailed(query);
    const result: DetailedValidationResult = {
      ...baseResult,
      suggestions: [],
      schemaErrors: []
    };
    
    // If there's a syntax error, try to provide suggestions
    if (!result.valid && result.errors?.length) {
      const error = result.errors[0];
      
      // Try to detect common typos and provide suggestions
      const typoSuggestions = this.getSyntaxSuggestions(query, error);
      if (typoSuggestions.length > 0) {
        result.suggestions = typoSuggestions;
      }
    }
    
    if (!this.schema || !result.valid) {
      return result;
    }

    const schemaErrors: SchemaError[] = [];
    const ast = this.parse(query).ast;
    
    if (ast) {
      // Check measurements
      const measurements = this.getMeasurements(query);
      for (const measurement of measurements) {
        if (!measurement.startsWith('/') && !this.schema.measurements.includes(measurement)) {
          const suggestion = this.findSimilar(measurement, this.schema.measurements);
          schemaErrors.push({
            type: 'UNKNOWN_MEASUREMENT',
            message: `Unknown measurement: ${measurement}`,
            suggestion: suggestion ? `Did you mean '${suggestion}'?` : undefined
          });
        }
      }

      // Check fields
      const fields = this.getSelectedFields(query);
      const measurement = measurements[0]; // Simplified for single measurement
      if (measurement && this.schema.fieldKeys[measurement]) {
        for (const field of fields) {
          if (field !== '*' && !field.includes('(') && 
              !this.schema.fieldKeys[measurement].includes(field)) {
            result.warnings = result.warnings || [];
            result.warnings.push({
              type: 'UNKNOWN_FIELD',
              message: `Unknown field '${field}' for measurement '${measurement}'`,
              suggestion: `Available fields: ${this.schema.fieldKeys[measurement].join(', ')}`
            });
          }
        }
      }
      
      // Check tags in WHERE clause
      const whereMatch = query.match(/WHERE\s+(\w+)\s*=/i);
      if (whereMatch && measurement && this.schema.tagKeys[measurement]) {
        const tagName = whereMatch[1];
        if (tagName !== 'time' && !this.schema.tagKeys[measurement].includes(tagName)) {
          result.warnings = result.warnings || [];
          result.warnings.push({
            type: 'UNKNOWN_TAG',
            message: `Unknown tag '${tagName}' for measurement '${measurement}'`,
            suggestion: `Available tags: ${this.schema.tagKeys[measurement].join(', ')}`
          });
        }
      }
    }

    if (schemaErrors.length > 0) {
      result.valid = false;
      result.schemaErrors = schemaErrors;
      if (schemaErrors[0].suggestion) {
        result.suggestions = [schemaErrors[0].suggestion];
      }
    }

    return result;
  }

  /**
   * Try to auto-fix common syntax errors
   */
  tryAutoFix(query: string): AutoFixResult {
    let fixed = query;
    const issues: string[] = [];

    // Fix unquoted string values
    const unquotedStringPattern = /(\w+)\s*=\s*([a-zA-Z][a-zA-Z0-9_]*)\b(?!\()/g;
    if (unquotedStringPattern.test(fixed)) {
      fixed = fixed.replace(unquotedStringPattern, "$1 = '$2'");
      issues.push("unquoted string value");
    }

    // Fix missing duration units
    const missingUnitPattern = /now\(\)\s*-\s*(\d+)(?!\w)/g;
    if (missingUnitPattern.test(fixed)) {
      fixed = fixed.replace(missingUnitPattern, "now() - $1h");
      issues.push("missing duration unit");
    }

    return {
      fixed: fixed !== query ? fixed : undefined,
      issue: issues.join(", "),
      original: query
    };
  }

  /**
   * Analyze query performance and provide suggestions
   */
  analyzePerformance(query: string): PerformanceAnalysis {
    const suggestions: PerformanceSuggestion[] = [];
    const ast = this.parse(query).ast;

    if (!ast) {
      return { suggestions: [] };
    }

    // Check for missing time constraint
    if (!this.hasTimeConstraint(query)) {
      suggestions.push({
        type: 'ADD_TIME_CONSTRAINT',
        message: 'Query has no time constraint. Consider adding a WHERE clause with time range.',
        impact: 'high',
        suggestion: this.addTimeConstraint(query, '1h')
      });
    }

    // Check for SELECT *
    if (query.includes('SELECT *') || query.includes('select *')) {
      suggestions.push({
        type: 'AVOID_SELECT_STAR',
        message: 'Avoid using SELECT *. Specify only needed fields.',
        impact: 'medium'
      });
    }

    // Check for missing LIMIT
    if (!ast.limit && !ast.groupBy) {
      suggestions.push({
        type: 'ADD_LIMIT',
        message: 'Consider adding LIMIT to prevent large result sets.',
        impact: 'medium',
        suggestion: query + ' LIMIT 1000'
      });
    }

    // Check for large time ranges that could benefit from CQ
    const hasAggregates = this.hasAggregateFunction(query);
    const hasTimeGroupBy = query.toLowerCase().includes('group by time');
    const timeRange = this.extractTimeRange(query);
    
    if (hasAggregates && hasTimeGroupBy && timeRange && timeRange.days >= 30) {
      suggestions.push({
        type: 'USE_CONTINUOUS_QUERY',
        message: 'Consider using a continuous query for this aggregation over large time range.',
        impact: 'high'
      });
    }

    // Check for very old data queries
    if (timeRange && timeRange.days >= 365) {
      suggestions.push({
        type: 'USE_RETENTION_POLICY',
        message: 'Consider using a longer retention policy for old data.',
        impact: 'medium'
      });
    }

    return { suggestions };
  }

  /**
   * Get query complexity score
   */
  getComplexityScore(query: string): number {
    let score = 0;
    const ast = this.parse(query).ast;

    if (!ast) return 0;

    // Base complexity
    score += 1;

    // Aggregation functions
    if (this.hasAggregateFunction(query)) {
      score += 3;
    }

    // WHERE clause
    if (ast.where) {
      score += 2;
      // Regex adds complexity
      if (this.hasRegexPattern(query)) {
        score += 3;
      }
    }

    // GROUP BY
    if (ast.groupBy) {
      score += 3;
      const fields = this.getGroupByFields(query);
      score += fields.length;
    }

    // ORDER BY
    if (ast.orderBy) {
      score += 2;
    }

    // Subqueries
    if (this.hasSubquery(query)) {
      score += 5;
    }

    // Large LIMIT
    const limit = this.getLimit(ast);
    if (limit && limit > 1000) {
      score += 2;
    }

    return score;
  }

  /**
   * Build query from options
   */
  buildQuery(options: QueryBuilderOptions): string {
    const parts: string[] = [];

    // SELECT clause
    if (options.aggregation && options.field) {
      parts.push(`SELECT ${options.aggregation}(${options.field})`);
    } else if (options.fields) {
      parts.push(`SELECT ${options.fields.join(', ')}`);
    } else {
      parts.push('SELECT *');
    }

    // FROM clause
    parts.push(`FROM ${options.measurement}`);

    // WHERE clause
    if (options.where) {
      const conditions: string[] = [];
      for (const [key, value] of Object.entries(options.where)) {
        if (key === 'time') {
          conditions.push(`time ${value}`);
        } else {
          conditions.push(`${key} = '${value}'`);
        }
      }
      if (conditions.length > 0) {
        parts.push(`WHERE ${conditions.join(' AND ')}`);
      }
    }

    // GROUP BY clause
    if (options.groupBy) {
      parts.push(`GROUP BY ${options.groupBy.join(', ')}`);
    }

    // LIMIT clause
    if (options.limit) {
      parts.push(`LIMIT ${options.limit}`);
    }

    return parts.join(' ');
  }

  /**
   * Escape identifier if needed
   */
  escapeIdentifier(identifier: string): string {
    // Check if identifier needs escaping
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
      return identifier;
    }
    // Escape with double quotes
    return `"${identifier.replace(/"/g, '\\"')}"`;
  }

  /**
   * Format duration in seconds to InfluxQL duration string
   */
  formatDurationSeconds(seconds: number): string {
    if (seconds % 604800 === 0) return `${seconds / 604800}w`;
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
  }

  /**
   * Document a query
   */
  documentQuery(query: string): QueryDocumentation {
    const operations: string[] = [];
    const ast = this.parse(query).ast;

    if (this.hasAggregateFunction(query)) {
      operations.push('aggregation');
    }
    if (ast?.where) {
      operations.push('filtering');
    }
    if (ast?.groupBy) {
      operations.push('grouping');
    }
    if (ast?.orderBy) {
      operations.push('sorting');
    }

    return {
      description: `InfluxQL query performing ${operations.join(', ')}`,
      operations,
      timeRange: this.extractTimeRange(query)
    };
  }

  /**
   * Explain query in human-readable format
   */
  explainQuery(query: string): QueryExplanation {
    const ast = this.parse(query).ast;
    const explanation: QueryExplanation = {};

    if (!ast) {
      return { error: 'Invalid query' };
    }

    // Explain SELECT
    const fields = this.getSelectedFields(query);
    if (fields.length === 1 && fields[0] === '*') {
      explanation.select = 'Select all fields';
    } else if (this.hasAggregateFunction(query)) {
      const funcs = this.getAggregateFunctions(query);
      explanation.select = `Calculate the ${funcs[0].toLowerCase()} of '${fields[0].replace(/\w+\((.*?)\)/, '$1')}' field`;
    } else {
      explanation.select = `Select fields: ${fields.join(', ')}`;
    }

    // Explain FROM
    const measurements = this.getMeasurements(query);
    explanation.from = `Query data from '${measurements[0]}' measurement`;

    // Explain WHERE
    if (ast.where) {
      const conditions = this.getWhereConditions(query);
      if (conditions.length === 1) {
        explanation.where = `Filter where ${this.explainCondition(conditions[0])}`;
      } else {
        explanation.where = `Apply ${conditions.length} filter conditions`;
      }
    }

    // Explain GROUP BY
    if (ast.groupBy) {
      const fields = this.getGroupByFields(query);
      const timeGroup = fields.find(f => f.startsWith('time('));
      if (timeGroup) {
        const interval = timeGroup.match(/time\(([^)]+)\)/)?.[1];
        const humanInterval = this.formatDuration(interval || '');
        explanation.groupBy = `Group results by ${humanInterval} intervals`;
      } else {
        explanation.groupBy = `Group results by ${fields.join(', ')}`;
      }
    }

    // Explain LIMIT
    if (ast.limit) {
      explanation.limit = `Return at most ${ast.limit} results`;
    }

    return explanation;
  }

  /**
   * Convert Flux query to InfluxQL (basic support)
   */
  convertFromFlux(fluxQuery: string): string {
    // This is a simplified converter for basic queries
    let influxQL = 'SELECT ';
    
    // Extract measurement
    const measurementMatch = fluxQuery.match(/r\._measurement\s*==\s*"([^"]+)"/);
    const measurement = measurementMatch ? measurementMatch[1] : 'measurement';
    
    // Extract time range
    const rangeMatch = fluxQuery.match(/range\(start:\s*(-?\d+[hdwm])/);
    const timeRange = rangeMatch ? rangeMatch[1] : '1h';
    
    // Check for aggregation
    if (fluxQuery.includes('mean()')) {
      influxQL += 'MEAN(*) ';
    } else if (fluxQuery.includes('sum()')) {
      influxQL += 'SUM(*) ';
    } else if (fluxQuery.includes('count()')) {
      influxQL += 'COUNT(*) ';
    } else {
      influxQL += '* ';
    }
    
    influxQL += `FROM ${measurement} WHERE time > now() - ${timeRange.replace('-', '')}`;
    
    return influxQL;
  }

  /**
   * Convert SQL query to InfluxQL (basic support)
   */
  convertFromSQL(sqlQuery: string): string {
    let influxQL = sqlQuery;
    
    // Replace SQL functions with InfluxQL equivalents
    influxQL = influxQL.replace(/\bAVG\(/gi, 'MEAN(');
    influxQL = influxQL.replace(/\bNOW\(\)/gi, 'now()');
    
    // Convert INTERVAL syntax to InfluxQL duration
    influxQL = influxQL.replace(/INTERVAL\s+(\d+)\s+HOUR/gi, '$1h');
    influxQL = influxQL.replace(/INTERVAL\s+(\d+)\s+DAY/gi, '$1d');
    influxQL = influxQL.replace(/INTERVAL\s+(\d+)\s+WEEK/gi, '$1w');
    
    return influxQL;
  }

  // Helper methods for Phase 4
  
  private getSyntaxSuggestions(query: string, error: ValidationError): string[] {
    const suggestions: string[] = [];
    const lowerQuery = query.toLowerCase();
    
    // Check for common typos in keywords (word boundaries)
    const keywordTypos: { [key: string]: string } = {
      'selct': 'SELECT',
      'slect': 'SELECT',
      'form': 'FROM',
      'frm': 'FROM',
      'wehre': 'WHERE',
      'whre': 'WHERE',
      'wher': 'WHERE',
      'gropu': 'GROUP',
      'grup': 'GROUP',
      'ordr': 'ORDER',
      'oder': 'ORDER',
      'limi': 'LIMIT',
      'limt': 'LIMIT',
      'tim': 'time'
    };
    
    // Match typos at word boundaries  
    const words = lowerQuery.split(/[\s(),]+/);
    for (const word of words) {
      const cleanWord = word.replace(/[^a-z]/g, '');
      if (keywordTypos[cleanWord]) {
        suggestions.push(`Did you mean '${keywordTypos[cleanWord]}'?`);
        break;
      }
    }
    
    // Check for missing keywords
    if (lowerQuery.includes('select') && !lowerQuery.includes('from')) {
      suggestions.push("Missing 'FROM' keyword");
    }
    
    // Handle unclosed quotes/parentheses
    if (error.message.toLowerCase().includes('expected') && 
        error.message.toLowerCase().includes('but end of input found')) {
      if (query.split('"').length % 2 === 0) {
        suggestions.push("Unclosed double quote");
        error.message = "Unclosed double quote in query";
      }
      if (query.split("'").length % 2 === 0) {
        suggestions.push("Unclosed single quote");
        error.message = "Unclosed single quote in query";
      }
      const openParen = (query.match(/\(/g) || []).length;
      const closeParen = (query.match(/\)/g) || []).length;
      if (openParen > closeParen) {
        suggestions.push("Unclosed parenthesis");
        error.message = "Unclosed parenthesis in query";
      }
    }
    
    return suggestions;
  }

  private findSimilar(str: string, candidates: string[]): string | null {
    // Simple Levenshtein distance for finding similar strings
    let minDistance = Infinity;
    let closest: string | null = null;
    
    for (const candidate of candidates) {
      const distance = this.levenshtein(str, candidate);
      if (distance < minDistance && distance <= 3) {
        minDistance = distance;
        closest = candidate;
      }
    }
    
    return closest;
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[b.length][a.length];
  }

  private extractTimeRange(query: string): { days: number } | null {
    const match = query.match(/now\(\)\s*-\s*(\d+)([hdwm])/);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    let days = 0;
    switch (unit) {
      case 'h': days = value / 24; break;
      case 'd': days = value; break;
      case 'w': days = value * 7; break;
      case 'm': days = value / 1440; break;
    }
    
    return { days };
  }

  private formatDuration(duration: string): string {
    const match = duration.match(/^(\d+)([a-z]+)$/);
    if (!match) return duration;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    const units: { [key: string]: string } = {
      'ns': value === 1 ? 'nanosecond' : 'nanoseconds',
      'u': value === 1 ? 'microsecond' : 'microseconds',
      'µ': value === 1 ? 'microsecond' : 'microseconds',
      'ms': value === 1 ? 'millisecond' : 'milliseconds',
      's': value === 1 ? 'second' : 'seconds',
      'm': value === 1 ? 'minute' : 'minutes',
      'h': value === 1 ? 'hour' : 'hours',
      'd': value === 1 ? 'day' : 'days',
      'w': value === 1 ? 'week' : 'weeks'
    };
    
    return `${value} ${units[unit] || unit}`;
  }
  
  private explainCondition(condition: any): string {
    if (!condition) return '';
    
    if (condition.type === 'comparison') {
      return `${condition.left.name || condition.left.type} ${condition.operator === '=' ? 'equals' : condition.operator} '${condition.right.value || condition.right.name}'`;
    }
    
    return 'complex condition';
  }
}

// Type definitions for Phase 4
interface InfluxQLSchema {
  measurements: string[];
  tagKeys: { [measurement: string]: string[] };
  fieldKeys: { [measurement: string]: string[] };
  retentionPolicies?: string[];
}

interface DetailedValidationResult extends ValidationResult {
  suggestions?: string[];
  schemaErrors?: SchemaError[];
}

interface SchemaError {
  type: string;
  message: string;
  suggestion?: string;
}

interface AutoFixResult {
  fixed?: string;
  issue: string;
  original: string;
}

interface PerformanceAnalysis {
  suggestions: PerformanceSuggestion[];
}

interface PerformanceSuggestion {
  type: string;
  message: string;
  impact: 'low' | 'medium' | 'high';
  suggestion?: string;
}

interface QueryBuilderOptions {
  fields?: string[];
  measurement: string;
  where?: { [key: string]: string };
  groupBy?: string[];
  limit?: number;
  aggregation?: string;
  field?: string;
}

interface QueryDocumentation {
  description: string;
  operations: string[];
  timeRange: any;
}

interface QueryExplanation {
  select?: string;
  from?: string;
  where?: string;
  groupBy?: string;
  orderBy?: string;
  limit?: string;
  error?: string;
}

// Export a singleton instance
export const influxQLParser = new InfluxQLParser();