// Local type definitions to avoid circular dependency
export type JoinType = "and" | "or" | "unless";

export interface TimePoint {
  type: 'absolute' | 'relative' | 'now';
  value?: string;
  direction?: 'ago' | 'future';
}

export interface AbsoluteTimeRange {
  timeRangeType: 'absolute';
  start: TimePoint;
  end: TimePoint;
  at?: string;  // @ modifier timestamp
}

export interface RelativeTimeRange {
  timeRangeType: 'relative';
  timeRange: string;
  at?: string;  // @ modifier timestamp
}

export type TimeSpecification = AbsoluteTimeRange | RelativeTimeRange | { at: string };

export interface StreamQuery {
  type?: 'database' | 'stream';  // Optional type to distinguish database vs stream queries
  source: string;
  selector: string;
  timeRange?: string;  // Legacy relative time range
  timeRangeType?: 'relative' | 'absolute';  // New time range type indicator
  start?: TimePoint;  // For absolute ranges
  end?: TimePoint;    // For absolute ranges
  at?: string;        // @ modifier timestamp
  alias?: string;
  stream?: string;  // Optional stream name for source:stream syntax
  selectorParsed?: any;  // Parsed selector for more complex queries
}

interface LabelMapping {
  left: string;
  right: string;
}

export interface EventSequence {
  first: StreamQuery;
  operator: 'follows' | 'precedes' | 'before' | 'after';
  second: StreamQuery;
  constraint?: {
    type: 'within';
    duration: string;
  };
}

export interface ParsedQuery {
  type?: 'direct' | 'correlation' | 'aggregation' | 'database' | 'pattern';  // Query type
  leftStream: StreamQuery;
  rightStream: StreamQuery;
  joinType: JoinType;
  joinKeys: string[];
  timeWindow?: string;
  temporal?: string;
  grouping?: {
    side: "left" | "right";
    labels: string[];
  };
  ignoring?: string[];
  labelMappings?: Array<{ left: string; right: string }>;
  filter?: string;
  additionalStreams?: StreamQuery[];
  // For aggregation queries
  function?: string;
  groupBy?: string[];
  query?: ParsedQuery;  // Nested query for aggregations
  // For pattern queries
  sequence?: EventSequence;
}

interface ParsedQueryExtended extends ParsedQuery {
  labelMappings?: LabelMapping[];
  filter?: string;
  additionalStreams?: StreamQuery[];
}

export class QueryParser {
  parse(query: string): ParsedQueryExtended {
    // Remove extra whitespace and newlines
    let normalizedQuery = query.replace(/\s+/g, " ").trim();

    // Extract filter if present (e.g., {...}{status=~"4..|5.."})
    const filterMatch = normalizedQuery.match(/\)\s*(\{[^}]+\})\s*$/);
    let filter: string | undefined;
    if (filterMatch) {
      filter = filterMatch[1];
      normalizedQuery = normalizedQuery.replace(filterMatch[0], ")");
    }

    // Find all stream queries first
    const streams = this.extractAllStreams(normalizedQuery);
    if (streams.length < 2) {
      throw new Error("Invalid query: requires at least two streams");
    }

    // Extract all join operations
    const joins = this.extractJoinOperations(normalizedQuery);
    if (joins.length === 0) {
      throw new Error("Invalid query: missing join operator");
    }

    // Build the query structure
    const firstJoin = joins[0];
    const result: ParsedQueryExtended = {
      leftStream: streams[0],
      rightStream: streams[1],
      joinType: firstJoin.joinType,
      joinKeys: firstJoin.joinKeys,
      timeWindow: streams[0].timeRange,
      temporal: firstJoin.temporal,
      grouping: firstJoin.grouping,
      labelMappings: firstJoin.labelMappings,
      filter,
    };

    // Add additional streams if present (for 3+ stream correlations)
    if (streams.length > 2) {
      result.additionalStreams = streams.slice(2);
    }

    return result;
  }

  private extractAllStreams(query: string): StreamQuery[] {
    const streams: StreamQuery[] = [];
    // Match patterns like: loki({service="frontend"})[5m], graylog(service:backend)[5m], promql(http_requests_total{job="api"})[5m]
    const streamPattern = /(\w+)\s*\(([^)]*)\)\s*\[([^\]]+)\]/g;
    let match;

    while ((match = streamPattern.exec(query)) !== null) {
      streams.push({
        source: match[1],
        selector: match[2],
        timeRange: match[3],
        alias: this.extractAlias(match[2]),
      });
    }

    return streams;
  }

  private extractAlias(selector: string): string | undefined {
    // Check for alias syntax like: {service="frontend"} as frontend_logs
    const aliasMatch = selector.match(/\s+as\s+(\w+)$/);
    return aliasMatch ? aliasMatch[1] : undefined;
  }

  private extractJoinOperations(query: string): any[] {
    const joins: any[] = [];

    // Find join operators first
    const joinOperatorPattern = /\b(and|or|unless)\s+on\s*\(([^)]+)\)/gi;
    let match;

    while ((match = joinOperatorPattern.exec(query)) !== null) {
      const joinType = match[1].toLowerCase() as JoinType;
      const joinKeysRaw = match[2];
      const joinEnd = match.index + match[0].length;

      // Parse join keys and label mappings
      const { keys, mappings } = this.parseJoinKeys(joinKeysRaw);

      // Find the modifiers after this join (up to the next data source or end)
      const remainingQuery = query.substring(joinEnd);
      const nextSourceMatch = remainingQuery.search(/\b\w+\s*\(/);
      const modifierSection =
        nextSourceMatch > 0
          ? remainingQuery.substring(0, nextSourceMatch)
          : remainingQuery;

      // Debug logging removed for production

      // Extract modifiers from the section
      const temporal = this.extractModifier(
        modifierSection,
        /within\s*\(([^)]+)\)/
      );
      const ignoring = this.extractModifier(
        modifierSection,
        /ignoring\s*\(([^)]+)\)/
      );
      const grouping = this.extractGrouping(modifierSection);

      joins.push({
        joinType,
        joinKeys: keys,
        labelMappings: mappings,
        ignoring: ignoring
          ? ignoring.split(",").map((l) => l.trim())
          : undefined,
        temporal,
        grouping,
      });
    }

    return joins;
  }

  private extractModifier(
    section: string,
    pattern: RegExp
  ): string | undefined {
    const match = section.match(pattern);
    return match ? match[1] : undefined;
  }

  private extractGrouping(
    section: string
  ): { side: "left" | "right"; labels: string[] } | undefined {
    const groupingMatch = section.match(
      /(group_left|group_right)\s*(?:\(([^)]*)\))?/
    );
    if (!groupingMatch) return undefined;

    const side =
      groupingMatch[1] === "group_left"
        ? ("left" as const)
        : ("right" as const);
    const labels = groupingMatch[2]
      ? groupingMatch[2].split(",").map((l) => l.trim())
      : [];

    return { side, labels };
  }

  private parseJoinKeys(joinKeysRaw: string): {
    keys: string[];
    mappings?: LabelMapping[];
  } {
    const keys: string[] = [];
    const mappings: LabelMapping[] = [];

    const parts = joinKeysRaw.split(",").map((p) => p.trim());

    for (const part of parts) {
      // Check for label mapping syntax (e.g., session_id=trace_id)
      const mappingMatch = part.match(/^(\w+)\s*=\s*(\w+)$/);
      if (mappingMatch) {
        mappings.push({
          left: mappingMatch[1],
          right: mappingMatch[2],
        });
        keys.push(mappingMatch[1]); // Use left side as the key
      } else {
        keys.push(part);
      }
    }

    return {
      keys,
      mappings: mappings.length > 0 ? mappings : undefined,
    };
  }

  private parseStreamQuery(streamPart: string): StreamQuery {
    // Enhanced pattern to support various stream syntaxes
    const patterns = [
      // loki({service="frontend"})[5m]
      /^(\w+)\s*\((\{[^}]*\})\)\s*\[([^\]]+)\]$/,
      // graylog(service:backend)[5m]
      /^(\w+)\s*\(([^)]+)\)\s*\[([^\]]+)\]$/,
      // promql(http_requests_total{job="api"})[5m]
      /^(\w+)\s*\(([^)]+)\)\s*\[([^\]]+)\]$/,
    ];

    for (const pattern of patterns) {
      const match = streamPart.match(pattern);
      if (match) {
        return {
          source: match[1],
          selector: match[2],
          timeRange: match[3],
          alias: this.extractAlias(match[2]),
        };
      }
    }

    throw new Error(`Invalid stream query: ${streamPart}`);
  }

  validate(query: string): { valid: boolean; error?: string; details?: any } {
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
}

export class QueryBuilder {
  private query: string = "";

  addStream(source: string, selector: string, timeRange: string): this {
    if (this.query) {
      throw new Error("Join operator must be added before second stream");
    }
    this.query = `${source}(${selector})[${timeRange}]`;
    return this;
  }

  join(type: JoinType, keys: string[]): this {
    if (!this.query) {
      throw new Error("Add first stream before join operator");
    }
    this.query += ` ${type} on(${keys.join(",")})`;
    return this;
  }

  withTemporal(window: string): this {
    this.query += ` within(${window})`;
    return this;
  }

  withGrouping(side: "left" | "right", labels?: string[]): this {
    const groupType = side === "left" ? "group_left" : "group_right";
    const labelList = labels?.join(",") || "";
    this.query += ` ${groupType}(${labelList})`;
    return this;
  }

  andStream(source: string, selector: string, timeRange: string): this {
    this.query += ` ${source}(${selector})[${timeRange}]`;
    return this;
  }

  build(): string {
    if (!this.query) {
      throw new Error("Query is empty");
    }
    return this.query;
  }
}
