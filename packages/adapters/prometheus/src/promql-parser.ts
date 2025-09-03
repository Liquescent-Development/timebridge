/**
 * PromQL Query Parser
 * Provides validation and parsing for Prometheus Query Language using Peggy grammar
 */

// Type definitions for parsed PromQL AST
export interface PromQLAST {
  type: string;
  [key: string]: any;
}

export interface ParseResult {
  valid: boolean;
  ast?: PromQLAST;
  error?: string;
  suggestions?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}

export interface ValidationError {
  type: "SYNTAX" | "TYPE" | "FUNCTION" | "DURATION" | "LABEL" | "OPERATOR";
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

export interface ValidationWarning {
  type: "DEPRECATED" | "PERFORMANCE" | "BEST_PRACTICE" | "EXPERIMENTAL";
  message: string;
  suggestion?: string;
}

// Type guard for the generated parser
interface GeneratedPromQLParser {
  parse(input: string): PromQLAST;
}

// Function definitions with their signatures
const FUNCTIONS: Record<string, { args: string[]; returns: string }> = {
  // Rate functions
  rate: { args: ["matrix"], returns: "vector" },
  irate: { args: ["matrix"], returns: "vector" },
  increase: { args: ["matrix"], returns: "vector" },
  delta: { args: ["matrix"], returns: "vector" },
  idelta: { args: ["matrix"], returns: "vector" },

  // Aggregation over time
  avg_over_time: { args: ["matrix"], returns: "vector" },
  min_over_time: { args: ["matrix"], returns: "vector" },
  max_over_time: { args: ["matrix"], returns: "vector" },
  sum_over_time: { args: ["matrix"], returns: "vector" },
  count_over_time: { args: ["matrix"], returns: "vector" },
  quantile_over_time: { args: ["scalar", "matrix"], returns: "vector" },
  stddev_over_time: { args: ["matrix"], returns: "vector" },
  stdvar_over_time: { args: ["matrix"], returns: "vector" },

  // Math functions
  abs: { args: ["vector"], returns: "vector" },
  ceil: { args: ["vector"], returns: "vector" },
  floor: { args: ["vector"], returns: "vector" },
  round: { args: ["vector", "scalar?"], returns: "vector" },
  sqrt: { args: ["vector"], returns: "vector" },
  exp: { args: ["vector"], returns: "vector" },
  ln: { args: ["vector"], returns: "vector" },
  log2: { args: ["vector"], returns: "vector" },
  log10: { args: ["vector"], returns: "vector" },

  // Trigonometric
  sin: { args: ["vector"], returns: "vector" },
  cos: { args: ["vector"], returns: "vector" },
  tan: { args: ["vector"], returns: "vector" },
  asin: { args: ["vector"], returns: "vector" },
  acos: { args: ["vector"], returns: "vector" },
  atan: { args: ["vector"], returns: "vector" },
  sinh: { args: ["vector"], returns: "vector" },
  cosh: { args: ["vector"], returns: "vector" },
  tanh: { args: ["vector"], returns: "vector" },
  asinh: { args: ["vector"], returns: "vector" },
  acosh: { args: ["vector"], returns: "vector" },
  atanh: { args: ["vector"], returns: "vector" },
  deg: { args: ["vector"], returns: "vector" },
  rad: { args: ["vector"], returns: "vector" },
  pi: { args: [], returns: "scalar" },

  // Date/Time functions
  day_of_month: { args: ["vector?"], returns: "vector" },
  day_of_week: { args: ["vector?"], returns: "vector" },
  day_of_year: { args: ["vector?"], returns: "vector" },
  days_in_month: { args: ["vector?"], returns: "vector" },
  hour: { args: ["vector?"], returns: "vector" },
  minute: { args: ["vector?"], returns: "vector" },
  month: { args: ["vector?"], returns: "vector" },
  year: { args: ["vector?"], returns: "vector" },
  time: { args: [], returns: "scalar" },
  timestamp: { args: ["vector"], returns: "vector" },

  // Label functions
  label_join: {
    args: ["vector", "string", "string", "string..."],
    returns: "vector",
  },
  label_replace: {
    args: ["vector", "string", "string", "string", "string"],
    returns: "vector",
  },

  // Vector functions
  vector: { args: ["scalar"], returns: "vector" },
  scalar: { args: ["vector"], returns: "scalar" },
  sort: { args: ["vector"], returns: "vector" },
  sort_desc: { args: ["vector"], returns: "vector" },

  // Presence functions
  absent: { args: ["vector"], returns: "vector" },
  absent_over_time: { args: ["matrix"], returns: "vector" },
  present_over_time: { args: ["matrix"], returns: "vector" },

  // Histogram functions
  histogram_count: { args: ["vector"], returns: "vector" },
  histogram_sum: { args: ["vector"], returns: "vector" },
  histogram_avg: { args: ["vector"], returns: "vector" },
  histogram_fraction: {
    args: ["scalar", "scalar", "vector"],
    returns: "vector",
  },
  histogram_quantile: { args: ["scalar", "vector"], returns: "vector" },
  histogram_stddev: { args: ["vector"], returns: "vector" },
  histogram_stdvar: { args: ["vector"], returns: "vector" },

  // Prediction functions
  predict_linear: { args: ["matrix", "scalar"], returns: "vector" },
  deriv: { args: ["matrix"], returns: "vector" },
  holt_winters: { args: ["matrix", "scalar", "scalar"], returns: "vector" },

  // Other functions
  changes: { args: ["matrix"], returns: "vector" },
  clamp: { args: ["vector", "scalar", "scalar"], returns: "vector" },
  clamp_max: { args: ["vector", "scalar"], returns: "vector" },
  clamp_min: { args: ["vector", "scalar"], returns: "vector" },
  resets: { args: ["matrix"], returns: "vector" },

  // String functions
  up: { args: [], returns: "vector" },
  sgn: { args: ["vector"], returns: "vector" },
  last_over_time: { args: ["matrix"], returns: "vector" },
};

// Aggregation operators
const AGGREGATION_OPS = new Set([
  "sum",
  "min",
  "max",
  "avg",
  "group",
  "stddev",
  "stdvar",
  "count",
  "count_values",
  "bottomk",
  "topk",
  "quantile",
  "limitk",
  "limit_ratio",
]);

// Binary operators that require vector matching
const VECTOR_BINARY_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
]);

export class PromQLParser {
  private parser: GeneratedPromQLParser | null = null;

  constructor() {
    this.loadParser();
  }

  private loadParser(): void {
    try {
      // Try to load the generated parser
      /* eslint-disable @typescript-eslint/no-var-requires */
      this.parser =
        require("./generated/promql-parser.js") as GeneratedPromQLParser;
      /* eslint-enable @typescript-eslint/no-var-requires */
    } catch (error) {
      console.warn(
        "PromQL parser not generated yet. Run npm run generate-parser"
      );
      // Parser will be null, methods will use fallback validation
    }
  }

  /**
   * Parse a PromQL query and return the AST
   */
  parse(query: string): ParseResult {
    if (!query || query.trim().length === 0) {
      return {
        valid: false,
        error: "Empty query",
      };
    }

    // Check query length limit
    if (query.length > 50000) {
      return {
        valid: false,
        error: "Query exceeds maximum length of 50,000 characters",
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
   * Validate a PromQL query
   */
  validate(query: string): ValidationResult {
    const parseResult = this.parse(query);

    if (!parseResult.valid) {
      const error = parseResult.error || "Invalid query syntax";
      let errorType: ValidationError["type"] = "SYNTAX";

      if (error.includes("function")) {
        errorType = "FUNCTION";
      } else if (error.includes("duration")) {
        errorType = "DURATION";
      } else if (error.includes("label") || query.match(/\{\s*\d+\s*=/)) {
        errorType = "LABEL";
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

  private validateAST(
    ast: PromQLAST,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    switch (ast.type) {
      case "query":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings);
        }
        break;

      case "function":
        this.validateFunction(ast, errors, warnings);
        if (ast.arguments) {
          for (const arg of ast.arguments) {
            this.validateAST(arg, errors, warnings);
          }
        }
        break;

      case "aggregation":
        if (!AGGREGATION_OPS.has(ast.operator)) {
          errors.push({
            type: "FUNCTION",
            message: `Unknown aggregation operator: ${ast.operator}`,
            suggestion: "Check available aggregation operators",
          });
        }
        if (ast.params?.expression) {
          this.validateAST(ast.params.expression, errors, warnings);
        }
        if (ast.params?.parameter) {
          this.validateAST(ast.params.parameter, errors, warnings);
        }
        break;

      case "binary":
      case "comparison":
        if (ast.left) this.validateAST(ast.left, errors, warnings);
        if (ast.right) this.validateAST(ast.right, errors, warnings);
        this.validateBinaryOperation(ast, errors, warnings);
        break;

      case "vector":
        this.validateVectorSelector(ast, errors, warnings);
        break;

      case "matrix":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings);
        }
        if (!ast.range) {
          errors.push({
            type: "SYNTAX",
            message: "Range selector missing duration",
          });
        }
        break;

      case "subquery":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings);
        }
        break;

      case "offset":
      case "at":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings);
        }
        break;

      case "unary":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings);
        }
        break;

      case "subexpression":
        if (ast.expression) {
          this.validateAST(ast.expression, errors, warnings);
        }
        break;
    }
  }

  private validateFunction(
    ast: PromQLAST,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    const funcDef = FUNCTIONS[ast.name];

    if (!funcDef) {
      // Check if it might be experimental
      if (ast.name.startsWith("__") || ast.name.includes("_info")) {
        warnings.push({
          type: "EXPERIMENTAL",
          message: `Function '${ast.name}' appears to be experimental`,
          suggestion: "Use with caution as it may change",
        });
      } else {
        errors.push({
          type: "FUNCTION",
          message: `Unknown function: ${ast.name}`,
          suggestion: "Check function name spelling",
        });
      }
      return;
    }

    // Validate argument count
    const requiredArgs = funcDef.args.filter((a) => !a.includes("?")).length;
    const maxArgs = funcDef.args.filter((a) => !a.includes("...")).length;
    const hasVariadic = funcDef.args.some((a) => a.includes("..."));

    const argCount = ast.arguments ? ast.arguments.length : 0;

    if (argCount < requiredArgs) {
      errors.push({
        type: "FUNCTION",
        message: `Function '${ast.name}' requires at least ${requiredArgs} arguments, got ${argCount}`,
      });
    } else if (!hasVariadic && argCount > maxArgs) {
      errors.push({
        type: "FUNCTION",
        message: `Function '${ast.name}' accepts at most ${maxArgs} arguments, got ${argCount}`,
      });
    }
  }

  private validateBinaryOperation(
    ast: PromQLAST,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // Check for scalar-vector operations that might need vector matching
    if (VECTOR_BINARY_OPS.has(ast.operator) && !ast.vectorMatching) {
      // This is fine for scalar operations, but warn if both sides are vectors
      if (
        this.isVectorExpression(ast.left) &&
        this.isVectorExpression(ast.right)
      ) {
        warnings.push({
          type: "BEST_PRACTICE",
          message: `Vector operation '${ast.operator}' without explicit matching`,
          suggestion:
            "Consider using 'on' or 'ignoring' for explicit label matching",
        });
      }
    }
  }

  private validateVectorSelector(
    ast: PromQLAST,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // Validate label matchers
    if (ast.labels) {
      for (const matcher of ast.labels) {
        if (matcher.type === "matcher") {
          // Check for invalid label names
          if (
            !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(matcher.label) &&
            matcher.label !== "__name__"
          ) {
            errors.push({
              type: "LABEL",
              message: `Invalid label name: ${matcher.label}`,
              suggestion: "Label names must start with letter or underscore",
            });
          }

          // Warn about regex performance
          if (
            (matcher.operator === "=~" || matcher.operator === "!~") &&
            matcher.value
          ) {
            const valueStr = typeof matcher.value === 'string' 
              ? matcher.value 
              : matcher.value.value;
            if (valueStr && valueStr.startsWith(".*")) {
              warnings.push({
                type: "PERFORMANCE",
                message: "Leading .* in regex can be slow",
                suggestion: "Consider removing leading .* if possible",
              });
            }
          }
        }
      }
    }
  }

  private isVectorExpression(ast: PromQLAST): boolean {
    if (!ast) return false;

    switch (ast.type) {
      case "vector":
      case "matrix":
      case "function":
        return FUNCTIONS[ast.name]?.returns === "vector";
      case "aggregation":
        return true;
      case "binary":
      case "comparison":
        return (
          this.isVectorExpression(ast.left) ||
          this.isVectorExpression(ast.right)
        );
      default:
        return false;
    }
  }

  private handleParseError(error: any, query: string): ParseResult {
    const location = error.location || {};
    const line = location.start?.line || 1;
    const column = location.start?.column || 1;

    let message = error.message || "Parse error";
    const suggestions: string[] = [];

    // Check for unbalanced parentheses, brackets, and braces
    const openCount = (query.match(/\(/g) || []).length;
    const closeCount = (query.match(/\)/g) || []).length;
    const bracketOpenCount = (query.match(/\[/g) || []).length;
    const bracketCloseCount = (query.match(/\]/g) || []).length;
    const braceOpenCount = (query.match(/\{/g) || []).length;
    const braceCloseCount = (query.match(/\}/g) || []).length;

    if (openCount > closeCount) {
      message = "Unclosed parentheses - missing ')'";
      suggestions.push("Add closing parenthesis");
    } else if (openCount < closeCount) {
      message = "Too many closing parentheses";
      suggestions.push("Remove extra ')' or add opening '('");
    } else if (bracketOpenCount > bracketCloseCount) {
      message = "Unclosed bracket - missing ']'";
      suggestions.push("Close the range selector with ']'");
    } else if (bracketOpenCount < bracketCloseCount) {
      message = "Too many closing brackets";
      suggestions.push("Remove extra ']' or add opening '['");
    } else if (braceOpenCount > braceCloseCount) {
      message = "Unclosed brace - missing '}'";
      suggestions.push("Close the label matcher with '}'");
    } else if (braceOpenCount < braceCloseCount) {
      message = "Too many closing braces";
      suggestions.push("Remove extra '}' or add opening '{'");
    } else if (message.includes("Expected")) {
      const expected = this.extractExpected(message);
      // Check if this is a duration-related error
      if (expected.some(e => e.includes("dhmswy") || e.includes("ms"))) {
        suggestions.push("Duration must include a time unit (ms, s, m, h, d, w, y)");
      } else {
        suggestions.push(`Expected: ${expected.join(", ")}`);
      }
    }

    // Check for function errors
    if (message.includes("function") || query.match(/\w+\s*\(/)) {
      suggestions.push("Check function name and arguments");
    }

    // Check for duration errors
    if (message.includes("duration") || query.match(/\[\s*\d+\s*\]/)) {
      suggestions.push("Duration must include unit (s, m, h, d, w, y)");
    }

    // Check for missing duration unit specifically
    if (query.match(/\[\s*\d+\s*\]/) || (message.includes("ms") && message.includes("[dhmswy]"))) {
      suggestions.push("Duration must include a time unit like: 5m, 1h, 30s");
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

    // Check for balanced brackets
    const brackets = [
      { open: "(", close: ")", name: "parentheses" },
      { open: "[", close: "]", name: "brackets" },
      { open: "{", close: "}", name: "braces" },
    ];

    for (const bracket of brackets) {
      let count = 0;
      for (const char of query) {
        if (char === bracket.open) count++;
        if (char === bracket.close) count--;
        if (count < 0) {
          errors.push(`Unbalanced ${bracket.name}: too many closing`);
          break;
        }
      }
      if (count > 0) {
        errors.push(`Unbalanced ${bracket.name}: missing closing`);
      }
    }

    // Check for basic query patterns
    if (query.match(/^\s*[{}[\]()]\s*$/)) {
      errors.push("Query cannot be only brackets");
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
   * Convert AST back to PromQL query string
   */
  stringify(ast: PromQLAST): string {
    switch (ast.type) {
      case "query":
        return ast.expression ? this.stringify(ast.expression) : "";

      case "number":
        return String(ast.value);

      case "string":
        return `"${ast.value}"`;

      case "vector": {
        let result = ast.metric || "";
        if (ast.labels && ast.labels.length > 0) {
          const matchers = ast.labels
            .map((m: any) => {
              if (m.type === "matcher") {
                return `${m.label}${m.operator}"${m.value}"`;
              }
              return m;
            })
            .join(", ");
          result += `{${matchers}}`;
        }
        return result;
      }

      case "matrix":
        return `${this.stringify(ast.expression)}[${ast.range.raw}]`;

      case "binary":
      case "comparison": {
        const left = this.stringify(ast.left);
        const right = this.stringify(ast.right);
        const op = ast.operator;
        const bool = ast.bool ? " bool" : "";
        return `${left} ${op}${bool} ${right}`;
      }

      case "unary":
        return `${ast.operator}${this.stringify(ast.expression)}`;

      case "function": {
        const args = ast.arguments
          ? ast.arguments.map((a: any) => this.stringify(a)).join(", ")
          : "";
        return `${ast.name}(${args})`;
      }

      case "aggregation": {
        const params = ast.params ? this.stringify(ast.params.expression) : "";
        const modifier = ast.modifier
          ? ` ${ast.modifier.type}(${ast.modifier.labels.join(", ")})`
          : "";
        return `${ast.operator}${modifier}(${params})`;
      }

      case "subexpression":
        return `(${this.stringify(ast.expression)})`;

      case "offset":
        return `${this.stringify(ast.expression)} offset ${ast.offset.raw}`;

      case "at":
        return `${this.stringify(ast.expression)} @ ${
          ast.timestamp.type === "start"
            ? "start()"
            : ast.timestamp.type === "end"
            ? "end()"
            : ast.timestamp.value
        }`;

      case "subquery":
        return `${this.stringify(ast.expression)}[${ast.range.raw}:${
          ast.step ? ast.step.raw : ""
        }]`;

      case "duration":
        return ast.raw;

      default:
        return "";
    }
  }
}
