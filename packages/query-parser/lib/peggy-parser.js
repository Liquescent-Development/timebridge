"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NearleyQueryParser = exports.PeggyQueryParser = void 0;
// Generated file - typed import
// eslint-disable-next-line @typescript-eslint/no-var-requires
let generatedParser;
try {
  // Try loading from dist (for built package)
  generatedParser = require("./generated/parser.js");
} catch {
  // Try loading from src (for tests)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  generatedParser = require("../src/generated/parser.js");
}
class PeggyQueryParser {
  parse(query) {
    try {
      const result = generatedParser.parse(query);
      return this.transformParseResult(result);
    } catch (error) {
      if (error && typeof error === "object" && "location" in error) {
        const parseError = error;
        throw new Error(
          `Query parse error at line ${parseError.location.start.line}, ` +
            `column ${parseError.location.start.column}: ${parseError.message}`
        );
      }
      throw error;
    }
  }
  transformParseResult(result) {
    // Extract join info from the right stream (where it's attached by the grammar)
    const join = result.rightStream?.join || {};
    // Safely cast joinType to JoinType
    const joinTypeRaw = join.type || result.joinType || "and";
    const joinType =
      joinTypeRaw === "and" || joinTypeRaw === "or" || joinTypeRaw === "unless"
        ? joinTypeRaw
        : "and";
    // Transform grouping if present
    let grouping;
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
      leftStream: result.leftStream,
      rightStream: result.rightStream,
      joinType,
      joinKeys: join.keys || result.joinKeys || [],
      timeWindow: result.leftStream.timeRange,
      temporal: join.temporal || result.temporal,
      grouping,
      ignoring: join.ignoring || result.ignoring,
      labelMappings: join.labelMappings || result.labelMappings,
      filter: result.filter,
      additionalStreams: result.additionalStreams,
    };
  }
  validate(query) {
    try {
      const parsed = this.parse(query);
      return {
        valid: true,
        details: {
          streams: parsed.additionalStreams
            ? 2 + parsed.additionalStreams.length
            : 2,
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
   * Get syntax suggestions for autocomplete at a given position
   */
  getSuggestions(query, position) {
    const suggestions = [];
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
      suggestions.push("loki(", "graylog(", "promql(");
    }
    return suggestions;
  }
  /**
   * Format a query with proper indentation
   */
  formatQuery(query) {
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
exports.PeggyQueryParser = PeggyQueryParser;
// Alternative: Use Nearley.js (another pure JS parser)
class NearleyQueryParser {}
exports.NearleyQueryParser = NearleyQueryParser;
//# sourceMappingURL=peggy-parser.js.map
