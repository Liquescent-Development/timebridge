/**
 * Graylog Query Parser
 * Provides validation and parsing for Graylog queries using Peggy grammar
 */

// Type definitions for parsed Graylog AST
export interface GraylogAST {
  type: string;
  [key: string]: any;
}

export interface ParseResult {
  valid: boolean;
  ast?: GraylogAST;
  error?: string;
  suggestions?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}

export interface ValidationError {
  type: "SYNTAX" | "SEMANTIC" | "FIELD" | "OPERATOR" | "RANGE" | "ESCAPE";
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

export interface ValidationWarning {
  type:
    | "PERFORMANCE"
    | "DEPRECATED"
    | "BEST_PRACTICE"
    | "UNKNOWN_FIELD"
    | "LEADING_WILDCARD";
  message: string;
  suggestion?: string;
}

// Type guard for the generated parser
interface GeneratedGraylogParser {
  parse(input: string): GraylogAST;
}

export class GraylogParser {
  private parser: GeneratedGraylogParser | null = null;
  private allowLeadingWildcards: boolean = false;

  // Common Graylog fields
  private readonly SYSTEM_FIELDS = new Set([
    "message",
    "full_message",
    "source",
    "timestamp",
    "_id",
    "level",
    "facility",
    "line",
    "file",
  ]);

  // Reserved keywords that must be uppercase
  private readonly BOOLEAN_OPERATORS = new Set(["AND", "OR", "NOT"]);

  // Characters that must be escaped
  private readonly ESCAPE_CHARS = new Set([
    "&",
    "|",
    ":",
    "\\",
    "/",
    "+",
    "-",
    "!",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    "^",
    '"',
    "~",
    "*",
    "?",
  ]);

  constructor(options: { allowLeadingWildcards?: boolean } = {}) {
    this.allowLeadingWildcards = options.allowLeadingWildcards || false;
    this.loadParser();
  }

  private loadParser(): void {
    try {
      // Try to load the generated parser
      /* eslint-disable @typescript-eslint/no-var-requires */
      this.parser =
        require("./generated/graylog-parser.js") as GeneratedGraylogParser;
      /* eslint-enable @typescript-eslint/no-var-requires */
    } catch (error) {
      console.warn(
        "Graylog parser not generated yet. Run npm run generate-parser"
      );
      // Parser will be null, methods will use fallback validation
    }
  }

  /**
   * Parse a Graylog query and return the AST
   */
  parse(query: string): ParseResult {
    if (!query || query.trim().length === 0) {
      // Empty query matches all documents
      return {
        valid: true,
        ast: {
          type: "query",
          expression: { type: "match_all" },
        },
      };
    }

    // Check query length limit
    if (query.length > 10000) {
      return {
        valid: false,
        error: "Query exceeds maximum length of 10,000 characters",
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
   * Validate a Graylog query without full parsing
   */
  validate(
    query: string,
    schema?: { fields?: string[]; tags?: string[] }
  ): ValidationResult {
    const parseResult = this.parse(query);

    if (!parseResult.valid) {
      const error = parseResult.error || "Invalid query syntax";
      let errorType: ValidationError["type"] = "SYNTAX";
      let suggestion: string | undefined;
      
      // Check for specific error types
      if (error.includes("Boolean operator must be uppercase")) {
        errorType = "OPERATOR";
      }
      
      // Add suggestions based on parseResult.suggestions
      if (parseResult.suggestions && parseResult.suggestions.length > 0) {
        suggestion = parseResult.suggestions[0];
      }
      
      return {
        valid: false,
        errors: [
          {
            type: errorType,
            message: error,
            suggestion,
          },
        ],
      };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (parseResult.ast) {
      this.validateAST(parseResult.ast, errors, warnings, schema);
    }

    // Check for common issues
    this.checkCommonIssues(query, errors, warnings);

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private validateAST(
    ast: GraylogAST,
    errors: ValidationError[],
    warnings: ValidationWarning[],
    schema?: { fields?: string[]; tags?: string[] }
  ): void {
    switch (ast.type) {
      case "query":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings, schema);
        }
        break;

      case "boolean":
        if (!this.BOOLEAN_OPERATORS.has(ast.operator)) {
          errors.push({
            type: "OPERATOR",
            message: `Boolean operator must be uppercase: ${ast.operator}`,
            suggestion: `Use '${ast.operator.toUpperCase()}' instead`,
          });
        }
        if (ast.clauses) {
          ast.clauses.forEach((clause: GraylogAST) => {
            this.validateAST(clause, errors, warnings, schema);
          });
        }
        break;

      case "field":
        if (
          schema?.fields &&
          !schema.fields.includes(ast.field) &&
          !this.SYSTEM_FIELDS.has(ast.field)
        ) {
          warnings.push({
            type: "UNKNOWN_FIELD",
            message: `Unknown field: ${ast.field}`,
            suggestion:
              "Check field name spelling or verify field exists in your data",
          });
        }
        if (ast.value) {
          this.validateAST(ast.value, errors, warnings, schema);
        }
        break;

      case "wildcard":
        if (
          ast.pattern &&
          (ast.pattern.startsWith("*") || ast.pattern.startsWith("?"))
        ) {
          if (!this.allowLeadingWildcards) {
            warnings.push({
              type: "LEADING_WILDCARD",
              message: "Leading wildcards can cause performance issues",
              suggestion:
                "Consider enabling allow_leading_wildcard_searches if needed",
            });
          }
        }
        break;

      case "range":
        this.validateRange(ast, errors);
        break;

      case "not":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings, schema);
        }
        break;

      case "group":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings, schema);
        }
        break;
    }
  }

  private validateRange(ast: GraylogAST, errors: ValidationError[]): void {
    if (ast.type !== "range") return;

    // Check for valid range bounds
    if (ast.from && ast.to) {
      // Validate datetime formats if applicable
      if (
        ast.from.type === "datetime" &&
        !this.isValidDateTime(ast.from.value)
      ) {
        errors.push({
          type: "RANGE",
          message: `Invalid datetime format in range: ${ast.from.value}`,
          suggestion: "Use format: YYYY-MM-DD HH:MM:SS.sss or ISO 8601",
        });
      }
      if (ast.to.type === "datetime" && !this.isValidDateTime(ast.to.value)) {
        errors.push({
          type: "RANGE",
          message: `Invalid datetime format in range: ${ast.to.value}`,
          suggestion: "Use format: YYYY-MM-DD HH:MM:SS.sss or ISO 8601",
        });
      }
    }
  }

  private isValidDateTime(value: string): boolean {
    // Check for Graylog datetime format: YYYY-MM-DD HH:MM:SS.sss
    const graylogFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/;
    // Check for ISO 8601 format
    const isoFormat =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/;

    return graylogFormat.test(value) || isoFormat.test(value);
  }

  private checkCommonIssues(
    query: string,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // Check for lowercase boolean operators with word boundaries
    const andMatch = query.match(/\band\b/i);
    const hasUpperAND = /\bAND\b/.test(query);
    if (andMatch && !hasUpperAND) {
      errors.push({
        type: "OPERATOR",
        message: "Boolean operator AND must be uppercase",
        suggestion: 'Replace "and" with "AND"',
      });
    }
    
    const orMatch = query.match(/\bor\b/i);
    const hasUpperOR = /\bOR\b/.test(query);
    if (orMatch && !hasUpperOR) {
      errors.push({
        type: "OPERATOR",
        message: "Boolean operator OR must be uppercase",
        suggestion: 'Replace "or" with "OR"',
      });
    }
    
    const notMatch = query.match(/\bnot\b/i);
    const hasUpperNOT = /\bNOT\b/.test(query);
    if (notMatch && !hasUpperNOT) {
      errors.push({
        type: "OPERATOR",
        message: "Boolean operator NOT must be uppercase",
        suggestion: 'Replace "not" with "NOT"',
      });
    }

    // Check for unescaped special characters in field values
    const fieldPattern = /(\w+):([^"\s]+)/g;
    let match;
    while ((match = fieldPattern.exec(query)) !== null) {
      const fieldValue = match[2];
      for (const char of this.ESCAPE_CHARS) {
        if (fieldValue.includes(char) && !fieldValue.includes(`\\${char}`)) {
          warnings.push({
            type: "BEST_PRACTICE",
            message: `Special character '${char}' should be escaped in field value`,
            suggestion: `Use '\\${char}' instead of '${char}'`,
          });
          break;
        }
      }
    }
  }

  private handleParseError(error: any, query: string): ParseResult {
    const location = error.location || {};
    const line = location.start?.line || 1;
    const column = location.start?.column || 1;

    let message = error.message || "Parse error";
    const suggestions: string[] = [];

    // Check for field query missing value
    if (query.endsWith(":") && message.includes("end of input found")) {
      message = "Field query missing value";
      suggestions.push('Add a value after the colon, e.g., field:value or field:"phrase value"');
    }
    // Provide specific error messages and suggestions
    else if (message.includes("Expected")) {
      const expected = this.extractExpected(message);
      suggestions.push(`Expected: ${expected.join(", ")}`);
    }

    if (
      message.includes("AND") ||
      message.includes("OR") ||
      message.includes("NOT")
    ) {
      suggestions.push("Boolean operators must be uppercase: AND, OR, NOT");
    }

    if (message.includes(":") && !query.endsWith(":")) {
      suggestions.push(
        'Check field query syntax: field:value or field:"phrase value"'
      );
    }

    return {
      valid: false,
      error: `${message} at line ${line}, column ${column}`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  private extractExpected(message: string): string[] {
    const match = message.match(/Expected (.+) but/);
    if (match) {
      return match[1].split(" or ").map((s) => s.replace(/['"]/g, ""));
    }
    return [];
  }

  private fallbackValidation(query: string): ParseResult {
    // Basic validation without full parser
    const errors: string[] = [];

    // Check for balanced parentheses
    let parenCount = 0;
    for (const char of query) {
      if (char === "(") parenCount++;
      if (char === ")") parenCount--;
      if (parenCount < 0) {
        errors.push("Unbalanced parentheses: too many closing parentheses");
        break;
      }
    }
    if (parenCount > 0) {
      errors.push("Unbalanced parentheses: missing closing parenthesis");
    }

    // Check for balanced quotes
    const quoteCount = (query.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      errors.push("Unbalanced quotes");
    }

    // Check for valid field syntax
    const fieldPattern = /(\w+):\s*$/;
    if (fieldPattern.test(query)) {
      errors.push("Field query missing value");
    }

    if (errors.length > 0) {
      return {
        valid: false,
        error: errors.join("; "),
      };
    }

    return {
      valid: true,
      ast: {
        type: "query",
        expression: { type: "unparsed", value: query },
      },
    };
  }

  /**
   * Convert AST back to query string
   */
  stringify(ast: GraylogAST): string {
    switch (ast.type) {
      case "query":
        return ast.expression ? this.stringify(ast.expression) : "";

      case "match_all":
        return "*";

      case "boolean": {
        const clauses = ast.clauses.map((c: GraylogAST) => this.stringify(c));
        return clauses.join(` ${ast.operator} `);
      }

      case "not":
        return `NOT ${this.stringify(ast.expression)}`;

      case "field": {
        const value =
          typeof ast.value === "object" ? this.stringify(ast.value) : ast.value;
        return `${ast.field}:${value}`;
      }

      case "term":
        return ast.value;

      case "phrase":
        return `"${ast.value}"`;

      case "wildcard":
        return ast.pattern;

      case "fuzzy":
        return `${ast.term}~${ast.distance || ""}`;

      case "proximity":
        return `"${ast.phrase}"~${ast.distance}`;

      case "regex":
        return `/${ast.pattern}/`;

      case "range": {
        const openBracket = ast.inclusive_from ? "[" : "{";
        const closeBracket = ast.inclusive_to ? "]" : "}";
        const from =
          typeof ast.from === "object"
            ? this.stringifyRangeValue(ast.from)
            : ast.from;
        const to =
          typeof ast.to === "object"
            ? this.stringifyRangeValue(ast.to)
            : ast.to;
        return `${openBracket}${from} TO ${to}${closeBracket}`;
      }

      case "unbounded_range": {
        const val =
          typeof ast.value === "object"
            ? this.stringifyRangeValue(ast.value)
            : ast.value;
        return `${ast.operator}${val}`;
      }

      case "compound_range":
        return `(${ast.conditions
          .map((c: GraylogAST) => this.stringify(c))
          .join(" AND ")})`;

      case "exists":
        return `_exists_:${ast.field}`;

      case "group":
        return `(${this.stringify(ast.expression)})`;

      default:
        return "";
    }
  }

  private stringifyRangeValue(value: any): string {
    if (value.type === "datetime") {
      return `"${value.value}"`;
    }
    if (value.type === "relative_time") {
      const offset = value.offset
        ? `${value.offset.operator}${value.offset.value}${value.offset.unit}`
        : "";
      return `${value.base}${offset}`;
    }
    return String(value.value || value);
  }
}
