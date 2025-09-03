// Import from local parser types to avoid circular dependency
import { ParsedQuery, StreamQuery, JoinType } from "./parser";

// Type definition for the generated parser
interface GeneratedParser {
  parse(input: string): ParseResult;
}

interface ParseResult {
  type?: 'direct' | 'correlation';
  // For direct queries
  stream?: StreamQuery;
  // For correlation queries
  leftStream?: StreamQuery;
  rightStream?: StreamQuery & { join?: JoinInfo };
  joinType?: string;
  joinKeys?: string[];
  temporal?: string;
  grouping?: { side: string; labels?: string[] };
  ignoring?: string[];
  labelMappings?: LabelMapping[];
  filter?: string;
  additionalStreams?: StreamQuery[];
}

interface JoinInfo {
  type?: string;
  keys?: string[];
  temporal?: string;
  grouping?: { side: string; labels?: string[] };
  ignoring?: string[];
  labelMappings?: LabelMapping[];
}

// Generated file - typed import
// eslint-disable-next-line @typescript-eslint/no-var-requires
let generatedParser: GeneratedParser;
try {
  // Try loading from the same directory structure (works in both src and dist)
  generatedParser = require("./generated/parser.js");
} catch (e) {
  // Fallback for different directory structures
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    generatedParser = require("../generated/parser.js");
  } catch (e2) {
    throw new Error(
      "Failed to load generated parser. Please ensure the package was built correctly."
    );
  }
}

// interface ParseError {
//   line: number;
//   column: number;
//   message: string;
// }

interface LabelMapping {
  left: string;
  right: string;
}

interface ParsedQueryExtended extends ParsedQuery {
  labelMappings?: LabelMapping[];
  filter?: string;
  additionalStreams?: StreamQuery[];
}

export class PeggyQueryParser {
  parse(query: string): ParsedQueryExtended {
    try {
      const result = generatedParser.parse(query);
      return this.transformParseResult(result);
    } catch (error) {
      if (error && typeof error === "object" && "location" in error) {
        const parseError = error as {
          location: { start: { line: number; column: number } };
          message: string;
        };
        throw new Error(
          `Query parse error at line ${parseError.location.start.line}, ` +
            `column ${parseError.location.start.column}: ${parseError.message}`
        );
      }
      throw error;
    }
  }

  private transformParseResult(result: ParseResult): ParsedQueryExtended {
    // Handle direct queries (single stream)
    if (result.type === 'direct' && result.stream) {
      // Return a special format for direct queries
      // We'll use leftStream for the single stream to maintain compatibility
      return {
        leftStream: result.stream,
        rightStream: null as any, // No right stream for direct queries
        joinType: 'and' as JoinType, // Default, not used
        joinKeys: [],
        timeWindow: result.stream.timeRange,
        filter: result.filter,
        // Add a flag to indicate this is a direct query
        additionalStreams: undefined,
      };
    }

    // Handle correlation queries (multi-stream)
    // Extract join info from the right stream (where it's attached by the grammar)
    const join = result.rightStream?.join || {};

    // Safely cast joinType to JoinType
    const joinTypeRaw = join.type || result.joinType || "and";
    const joinType =
      joinTypeRaw === "and" || joinTypeRaw === "or" || joinTypeRaw === "unless"
        ? (joinTypeRaw as JoinType)
        : ("and" as JoinType);

    // Transform grouping if present
    let grouping: ParsedQuery["grouping"] | undefined;
    const rawGrouping = join.grouping || result.grouping;
    if (rawGrouping && rawGrouping.side) {
      const side = rawGrouping.side === "right" ? "right" : "left";
      grouping = {
        side,
        labels: rawGrouping.labels || [],
      };
    }

    // Transform Peggy output to our expected format
    return {
      leftStream: result.leftStream!,
      rightStream: result.rightStream!,
      joinType,
      joinKeys: join.keys || result.joinKeys || [],
      timeWindow: result.leftStream?.timeRange,
      temporal: join.temporal || result.temporal,
      grouping,
      ignoring: join.ignoring || result.ignoring,
      labelMappings: join.labelMappings || result.labelMappings,
      filter: result.filter,
      additionalStreams: result.additionalStreams,
    };
  }

  validate(query: string): { valid: boolean; error?: string; details?: any } {
    try {
      const parsed = this.parse(query);
      const isDirect = !parsed.rightStream;
      
      return {
        valid: true,
        details: {
          type: isDirect ? 'direct' : 'correlation',
          streams: isDirect ? 1 : (parsed.additionalStreams
            ? 2 + parsed.additionalStreams.length
            : 2),
          joinType: parsed.joinType,
          temporal: !!parsed.temporal,
          hasFilter: !!parsed.filter,
          hasLabelMappings: !!(
            parsed.labelMappings && parsed.labelMappings.length > 0
          ),
        },
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check if a query is a direct (single-stream) query
   */
  isDirect(query: string): boolean {
    try {
      const parsed = this.parse(query);
      return !parsed.rightStream;
    } catch {
      return false;
    }
  }

  /**
   * Check if a query is a correlation (multi-stream) query
   */
  isCorrelation(query: string): boolean {
    try {
      const parsed = this.parse(query);
      return !!parsed.rightStream;
    } catch {
      return false;
    }
  }

  /**
   * Get syntax suggestions for autocomplete at a given position
   */
  getSuggestions(query: string, position: number): string[] {
    const suggestions: string[] = [];

    // Determine context based on position
    const beforeCursor = query.substring(0, position);
    // const afterCursor = query.substring(position);

    // Check what comes before cursor
    if (beforeCursor.match(/\s+$/)) {
      // After whitespace, suggest keywords
      if (beforeCursor.includes(")") && !beforeCursor.includes("[")) {
        suggestions.push("[5m]", "[1m]", "[30s]", "[1h]", "[24h]");
      } else if (beforeCursor.match(/\]\s*$/)) {
        suggestions.push("and on(", "or on(", "unless on(");
      } else if (beforeCursor.match(/\)\s*$/)) {
        // After join keys, suggest modifiers
        if (beforeCursor.includes(" on(")) {
          suggestions.push(
            "within(",
            "ignoring(",
            "group_left(",
            "group_right("
          );
        }
      }
    } else if (beforeCursor.endsWith("on(")) {
      // Suggest common join keys
      suggestions.push(
        "request_id",
        "trace_id",
        "session_id",
        "correlation_id",
        "span_id"
      );
    } else if (beforeCursor.endsWith("{")) {
      // Suggest label keys
      suggestions.push("service=", "level=", "job=", "instance=", "status=");
    } else if (
      beforeCursor.match(/=$/) ||
      beforeCursor.match(/!=$/) ||
      beforeCursor.match(/=~$/) ||
      beforeCursor.match(/!~$/)
    ) {
      // After operator, suggest common values
      if (beforeCursor.includes("service")) {
        suggestions.push('"frontend"', '"backend"', '"database"', '"cache"');
      } else if (beforeCursor.includes("level")) {
        suggestions.push('"info"', '"warn"', '"error"', '"debug"');
      } else if (beforeCursor.includes("status")) {
        suggestions.push('"200"', '"404"', '"500"', '"4.."', '"5.."');
      }
    } else if (!beforeCursor.trim()) {
      // At the beginning, suggest sources
      suggestions.push("loki(", "graylog(", "prometheus(", "influxdb(");
    }

    return suggestions;
  }

  /**
   * Format a query with proper indentation
   */
  formatQuery(query: string): string {
    try {
      const parsed = this.parse(query);
      let formatted = "";

      // Format first stream
      formatted += `${parsed.leftStream.source}(${parsed.leftStream.selector})[${parsed.leftStream.timeRange}]\n`;

      // Format join
      formatted += `  ${parsed.joinType} on(${parsed.joinKeys.join(", ")})`;

      // Add modifiers
      if (parsed.temporal) {
        formatted += ` within(${parsed.temporal})`;
      }
      if (parsed.grouping) {
        formatted += ` group_${parsed.grouping.side}(${
          parsed.grouping.labels?.join(", ") || ""
        })`;
      }
      formatted += "\n";

      // Format second stream
      formatted += `  ${parsed.rightStream.source}(${parsed.rightStream.selector})[${parsed.rightStream.timeRange}]`;

      // Add additional streams
      if (parsed.additionalStreams) {
        for (const stream of parsed.additionalStreams) {
          // Additional streams would have their own join info
          formatted += `\n  and on(${parsed.joinKeys.join(", ")})\n`;
          formatted += `  ${stream.source}(${stream.selector})[${stream.timeRange}]`;
        }
      }

      // Add filter
      if (parsed.filter) {
        formatted += `\n${parsed.filter}`;
      }

      return formatted;
    } catch {
      // If parsing fails, return original
      return query;
    }
  }
}

// Alternative: Use Nearley.js (another pure JS parser)
export class NearleyQueryParser {
  // Nearley is another excellent option that's pure JavaScript
  // It has a slightly different syntax but similar capabilities
  // We could implement this as an alternative if Peggy doesn't meet needs
}
