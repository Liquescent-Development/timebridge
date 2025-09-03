/**
 * LogQL Parser for Loki Adapter
 * Provides parsing, validation, and AST manipulation for LogQL queries
 */

import type { LogQLAST, ParseResult, ValidationResult, ValidationError, ValidationWarning } from './logql-types';

// Type for the generated parser (will be created by Peggy)
interface GeneratedLogQLParser {
  parse(input: string): any;
}

// Supported aggregation operations
const RANGE_OPS = new Set([
  'count_over_time',
  'rate',
  'rate_counter',
  'bytes_over_time',
  'bytes_rate',
  'absent_over_time',
  'sum_over_time',
  'avg_over_time',
  'max_over_time',
  'min_over_time',
  'first_over_time',
  'last_over_time',
  'stddev_over_time',
  'stdvar_over_time',
  'quantile_over_time',
]);

const VECTOR_OPS = new Set([
  'sum',
  'avg',
  'max',
  'min',
  'count',
  'stddev',
  'stdvar',
  'topk',
  'bottomk',
]);

// Parser types
const PARSER_TYPES = new Set([
  'json',
  'logfmt',
  'pattern',
  'regexp',
  'unpack',
]);

export class LogQLParser {
  private parser: GeneratedLogQLParser | null = null;

  constructor() {
    this.loadParser();
  }

  private loadParser(): void {
    try {
      // Try to load the generated parser
      /* eslint-disable @typescript-eslint/no-var-requires */
      this.parser = require('./generated/logql-parser.js') as GeneratedLogQLParser;
      /* eslint-enable @typescript-eslint/no-var-requires */
    } catch (error) {
      console.warn('LogQL parser not generated yet. Run npm run generate-parser');
      // Parser will be null, methods will use fallback validation
    }
  }

  /**
   * Parse a LogQL query and return the AST
   */
  parse(query: string): ParseResult {
    if (!query || query.trim().length === 0) {
      return {
        valid: false,
        error: 'Empty query',
      };
    }

    // Check query length limit
    if (query.length > 100000) {
      return {
        valid: false,
        error: 'Query exceeds maximum length of 100,000 characters',
      };
    }

    if (this.parser) {
      try {
        const ast = this.parser.parse(query);
        return {
          valid: true,
          ast,
        };
      } catch (error: any) {
        return this.handleParseError(error, query);
      }
    }

    // Fallback validation when parser not available
    return this.fallbackValidation(query);
  }

  /**
   * Validate a LogQL query
   */
  validate(query: string): ValidationResult {
    const parseResult = this.parse(query);

    if (!parseResult.valid) {
      const error = parseResult.error || 'Invalid query syntax';
      let errorType: ValidationError['type'] = 'SYNTAX';

      if (error.includes('pipeline')) {
        errorType = 'PIPELINE';
      } else if (error.includes('duration')) {
        errorType = 'DURATION';
      } else if (error.includes('label')) {
        errorType = 'LABEL';
      } else if (error.includes('parser')) {
        errorType = 'PARSER';
      }

      return {
        valid: false,
        errors: [
          {
            type: errorType,
            message: error,
            suggestion: parseResult.suggestions?.[0],
          },
        ],
      };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (parseResult.ast) {
      this.validateAST(parseResult.ast, errors, warnings);
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Convert AST back to LogQL string
   */
  stringify(ast: LogQLAST): string {
    if (!ast) {
      return '';
    }

    switch (ast.type) {
      case 'log':
        return this.stringifyLogQuery(ast);
      case 'rangeAggregation':
      case 'vectorAggregation':
      case 'binary':
      case 'logRange':
      case 'literal':
        return this.stringifyMetricQuery(ast);
      default:
        // Try as metric query for other types
        return this.stringifyMetricQuery(ast);
    }
  }

  /**
   * Determine if a query returns logs or metrics
   */
  getQueryType(ast: LogQLAST): 'log' | 'metric' {
    if (!ast || !ast.type) {
      return 'log';
    }

    // Check for metric query indicators
    if (ast.type === 'rangeAggregation' || 
        ast.type === 'vectorAggregation' ||
        ast.type === 'unwrapped' ||
        ast.type === 'binary') {
      return 'metric';
    }

    return 'log';
  }

  private validateAST(ast: any, errors: ValidationError[], warnings: ValidationWarning[]): void {
    // Validate selector
    if (ast.selector && ast.selector.matchers) {
      for (const matcher of ast.selector.matchers) {
        // Check for invalid label names
        if (matcher.label && /^\d+$/.test(matcher.label)) {
          errors.push({
            type: 'LABEL',
            message: `Invalid label name: "${matcher.label}". Label names cannot be purely numeric.`,
          });
        }

        // Warn about inefficient regex patterns
        if (matcher.operator === '=~' && matcher.value) {
          if (matcher.value.startsWith('.*')) {
            warnings.push({
              type: 'PERFORMANCE',
              message: `Leading .* in regex pattern for label "${matcher.label}" can be slow`,
              suggestion: 'Consider removing leading .* if possible',
            });
          }
        }
      }
    }

    // Validate pipeline order
    if (ast.pipeline) {
      this.validatePipelineOrder(ast.pipeline, errors);
    }

    // Validate aggregation operations
    if (ast.type === 'rangeAggregation' && !RANGE_OPS.has(ast.operation)) {
      errors.push({
        type: 'FUNCTION',
        message: `Unknown range aggregation: "${ast.operation}"`,
        suggestion: `Valid operations: ${Array.from(RANGE_OPS).join(', ')}`,
      });
    }

    if (ast.type === 'vectorAggregation' && !VECTOR_OPS.has(ast.operation)) {
      errors.push({
        type: 'FUNCTION',
        message: `Unknown vector aggregation: "${ast.operation}"`,
        suggestion: `Valid operations: ${Array.from(VECTOR_OPS).join(', ')}`,
      });
    }

    // Recursively validate nested expressions
    if (ast.expression) {
      this.validateAST(ast.expression, errors, warnings);
    }
    if (ast.left) {
      this.validateAST(ast.left, errors, warnings);
    }
    if (ast.right) {
      this.validateAST(ast.right, errors, warnings);
    }
  }

  private validatePipelineOrder(pipeline: any[], errors: ValidationError[]): void {
    let hasParser = false;
    let hasUnwrap = false;

    for (let i = 0; i < pipeline.length; i++) {
      const stage = pipeline[i];

      // Check parser placement
      if (stage.type === 'parser') {
        if (hasParser) {
          errors.push({
            type: 'PIPELINE',
            message: 'Only one parser stage is allowed in a pipeline',
            suggestion: 'Remove duplicate parser or combine extractions',
          });
        }
        hasParser = true;
      }

      // Label filters must come after a parser
      if (stage.type === 'labelFilter' && !hasParser) {
        errors.push({
          type: 'PIPELINE',
          message: 'Label filters require a parser stage first',
          suggestion: 'Add a parser (json, logfmt, pattern, regexp) before label filters',
        });
      }

      // Unwrap must be last
      if (stage.type === 'unwrap') {
        if (i !== pipeline.length - 1) {
          errors.push({
            type: 'PIPELINE',
            message: 'Unwrap must be the last stage in a pipeline',
          });
        }
        hasUnwrap = true;
      }
    }
  }

  private handleParseError(error: any, query: string): ParseResult {
    const location = error.location || {};
    const line = location.start?.line || 1;
    const column = location.start?.column || 1;

    let message = error.message || 'Parse error';
    const suggestions: string[] = [];

    // Check for unbalanced brackets
    const openBraces = (query.match(/\{/g) || []).length;
    const closeBraces = (query.match(/\}/g) || []).length;
    const openBrackets = (query.match(/\[/g) || []).length;
    const closeBrackets = (query.match(/\]/g) || []).length;
    const openParens = (query.match(/\(/g) || []).length;
    const closeParens = (query.match(/\)/g) || []).length;

    if (openBraces > closeBraces) {
      message = "Unclosed brace - missing '}'";
      suggestions.push("Close the selector with '}'");
    } else if (openBrackets > closeBrackets) {
      message = "Unclosed bracket - missing ']'";
      suggestions.push("Close the range selector with ']'");
    } else if (openParens > closeParens) {
      message = "Unclosed parenthesis - missing ')'";
      suggestions.push('Add closing parenthesis');
    }

    // Check for common mistakes
    if (query.includes('|') && !query.match(/\|\s*[=!~>]/)) {
      suggestions.push('Pipeline operators must be: |=, !=, |~, !~, |>, !>, or parser names');
    }

    if (query.match(/\[\s*\d+\s*\]/) && !query.match(/\[\s*\d+[smhdwy]/)) {
      suggestions.push('Duration must include a time unit like: [5m], [1h], [30s]');
    }

    return {
      valid: false,
      error: `${message} at line ${line}, column ${column}`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  private fallbackValidation(query: string): ParseResult {
    // Basic validation without full parser
    const errors: string[] = [];

    // Check for basic selector
    if (!query.includes('{') || !query.includes('}')) {
      errors.push('Query must include a selector like {job="nginx"}');
    }

    // Check for balanced brackets
    const brackets = [
      { open: '{', close: '}', name: 'braces' },
      { open: '[', close: ']', name: 'brackets' },
      { open: '(', close: ')', name: 'parentheses' },
    ];

    for (const bracket of brackets) {
      const openCount = (query.match(new RegExp('\\' + bracket.open, 'g')) || []).length;
      const closeCount = (query.match(new RegExp('\\' + bracket.close, 'g')) || []).length;
      if (openCount !== closeCount) {
        errors.push(`Unbalanced ${bracket.name}`);
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        error: errors.join(', '),
      };
    }

    return {
      valid: true,
      ast: null,
    };
  }

  private stringifyLogQuery(ast: any): string {
    let result = '';

    // Selector
    if (ast.selector) {
      result += this.stringifySelector(ast.selector);
    }

    // Pipeline
    if (ast.pipeline && ast.pipeline.length > 0) {
      for (const stage of ast.pipeline) {
        result += ' ' + this.stringifyPipelineStage(stage);
      }
    }

    return result;
  }

  private stringifyMetricQuery(ast: any): string {
    switch (ast.type) {
      case 'rangeAggregation':
        return this.stringifyRangeAggregation(ast);
      case 'vectorAggregation':
        return this.stringifyVectorAggregation(ast);
      case 'binary':
        return this.stringifyBinaryExpression(ast);
      case 'logRange':
        return this.stringifyLogRange(ast);
      case 'literal':
        return String(ast.value);
      default:
        return '';
    }
  }

  private stringifySelector(selector: any): string {
    if (!selector.matchers || selector.matchers.length === 0) {
      return '{}';
    }

    const matchers = selector.matchers
      .map((m: any) => `${m.label}${m.operator}"${m.value}"`)
      .join(', ');
    
    return `{${matchers}}`;
  }

  private stringifyPipelineStage(stage: any): string {
    switch (stage.type) {
      case 'lineFilter':
        return `${stage.operator} "${stage.value}"`;
      case 'parser':
        return `| ${stage.parser}`;
      case 'labelFilter':
        return `| ${stage.label} ${stage.operator} ${stage.value}`;
      case 'lineFormat':
        return `| line_format "${stage.template}"`;
      case 'labelFormat':
        return `| label_format ${stage.formats.map((f: any) => `${f.label}="${f.value}"`).join(', ')}`;
      case 'decolorize':
        return '| decolorize';
      case 'dropLabels':
        return `| drop ${stage.labels.join(', ')}`;
      case 'keepLabels':
        return `| keep ${stage.labels.join(', ')}`;
      default:
        return '';
    }
  }

  private stringifyRangeAggregation(ast: any): string {
    let result = `${ast.operation}(`;
    
    if (ast.parameter !== null && ast.parameter !== undefined) {
      result += `${ast.parameter}, `;
    }
    
    if (ast.expression) {
      if (ast.expression.type === 'logRange') {
        result += this.stringifyLogRange(ast.expression);
      } else if (ast.expression.type === 'unwrapped') {
        result += this.stringifyUnwrappedExpression(ast.expression);
      } else {
        result += this.stringifyLogQuery(ast.expression);
      }
    }
    
    result += ')';
    
    if (ast.grouping) {
      result += this.stringifyGrouping(ast.grouping);
    }
    
    return result;
  }

  private stringifyLogRange(ast: any): string {
    let result = this.stringifySelector(ast.selector);
    
    if (ast.pipeline && ast.pipeline.length > 0) {
      for (const stage of ast.pipeline) {
        result += ' ' + this.stringifyPipelineStage(stage);
      }
    }
    
    if (ast.duration) {
      result += `[${ast.duration.value || ast.duration}]`;
    }
    
    if (ast.offset) {
      result += ` offset ${ast.offset.value || ast.offset}`;
    }
    
    return result;
  }

  private stringifyUnwrappedExpression(ast: any): string {
    let result = this.stringifySelector(ast.selector);
    
    if (ast.pipeline && ast.pipeline.length > 0) {
      for (const stage of ast.pipeline) {
        result += ' ' + this.stringifyPipelineStage(stage);
      }
    }
    
    result += ` | unwrap `;
    
    if (ast.field.conversion) {
      result += `${ast.field.conversion}(${ast.field.field})`;
    } else {
      result += ast.field.field;
    }
    
    result += ` [${ast.duration.value || ast.duration}]`;
    
    if (ast.offset) {
      result += ` offset ${ast.offset.value || ast.offset}`;
    }
    
    return result;
  }

  private stringifyVectorAggregation(ast: any): string {
    let result = `${ast.operation}`;
    
    if (ast.grouping && ast.grouping.type === 'by') {
      result += this.stringifyGrouping(ast.grouping);
    }
    
    result += '(';
    
    if (ast.parameter !== null) {
      result += `${ast.parameter}, `;
    }
    
    if (ast.expression) {
      result += this.stringify(ast.expression);
    }
    
    result += ')';
    
    if (ast.grouping && ast.grouping.type === 'without') {
      result += this.stringifyGrouping(ast.grouping);
    }
    
    return result;
  }

  private stringifyBinaryExpression(ast: any): string {
    const left = ast.left.type ? this.stringify(ast.left) : this.stringifyMetricQuery(ast.left);
    const right = ast.right.type ? this.stringify(ast.right) : this.stringifyMetricQuery(ast.right);
    let operator = ast.operator;
    
    if (ast.vectorMatching) {
      operator += ' ' + this.stringifyVectorMatching(ast.vectorMatching);
    }
    
    return `${left} ${operator} ${right}`;
  }

  private stringifyGrouping(grouping: any): string {
    const labels = grouping.labels.join(', ');
    return ` ${grouping.type} (${labels})`;
  }

  private stringifyVectorMatching(matching: any): string {
    let result = `${matching.type} (${matching.labels.join(', ')})`;
    
    if (matching.grouping) {
      const labels = matching.grouping.labels.length > 0 
        ? `(${matching.grouping.labels.join(', ')})` 
        : '';
      result += ` ${matching.grouping.type}${labels}`;
    }
    
    return result;
  }
}

export default LogQLParser;