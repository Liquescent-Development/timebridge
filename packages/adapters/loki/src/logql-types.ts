/**
 * TypeScript types for LogQL parser
 */

// Main AST type
export type LogQLAST = LogExpression | MetricExpression;

// Expression types
export interface LogExpression {
  type: 'log';
  selector: Selector;
  pipeline: PipelineStage[];
}

export interface MetricExpression {
  type: 'metric' | 'rangeAggregation' | 'vectorAggregation' | 'binary' | 'unwrapped' | 'logRange' | 'literal' | 'labelReplace' | 'vector';
  [key: string]: any;
}

// Selector types
export interface Selector {
  type: 'selector';
  matchers: LabelMatcher[];
}

export interface LabelMatcher {
  type: 'matcher';
  label: string;
  operator: '=' | '!=' | '=~' | '!~';
  value: string;
}

// Pipeline stages
export type PipelineStage =
  | LineFilter
  | Parser
  | LabelFilter
  | LineFormat
  | LabelFormat
  | Decolorize
  | DropLabels
  | KeepLabels;

export interface LineFilter {
  type: 'lineFilter';
  operator: '|=' | '!=' | '|~' | '!~' | '|>' | '!>';
  value: string | OrFilter | IPFilter;
}

export interface OrFilter {
  type: 'or';
  values: string[];
}

export interface IPFilter {
  type: 'ip';
  cidr: string;
}

export interface Parser {
  type: 'parser';
  parser: 'json' | 'logfmt' | 'pattern' | 'regexp' | 'unpack';
  pattern?: string;
  flags?: string[];
  extractions?: Extraction[];
}

export interface Extraction {
  label: string;
  path: string;
}

export interface LabelFilter {
  type: 'labelFilter' | 'labelLogical';
  label?: string;
  operator?: string;
  value?: any;
  left?: LabelFilter;
  right?: LabelFilter;
}

export interface LineFormat {
  type: 'lineFormat';
  template: string;
}

export interface LabelFormat {
  type: 'labelFormat';
  formats: LabelFormatItem[];
}

export interface LabelFormatItem {
  label: string;
  value: string;
}

export interface Decolorize {
  type: 'decolorize';
}

export interface DropLabels {
  type: 'dropLabels';
  labels: string[];
}

export interface KeepLabels {
  type: 'keepLabels';
  labels: string[];
}

// Range and aggregation types
export interface LogRange {
  type: 'logRange';
  selector: Selector;
  duration: Duration;
  pipeline?: PipelineStage[];
  offset?: Duration;
}

export interface Duration {
  type: 'duration';
  value: string;
}

export interface Bytes {
  type: 'bytes';
  value: number;
  unit: string;
}

export interface RangeAggregation {
  type: 'rangeAggregation';
  operation: string;
  expression: LogRange;
  grouping?: Grouping;
}

export interface VectorAggregation {
  type: 'vectorAggregation';
  operation: string;
  parameter?: number;
  expression: MetricExpression;
  grouping?: Grouping;
}

export interface Grouping {
  type: 'by' | 'without';
  labels: string[];
}

export interface BinaryExpression {
  type: 'binary';
  operator: string;
  left: MetricExpression;
  right: MetricExpression;
  vectorMatching?: VectorMatching;
}

export interface VectorMatching {
  type: 'on' | 'ignoring';
  labels: string[];
  grouping?: GroupingModifier;
}

export interface GroupingModifier {
  type: 'group_left' | 'group_right';
  labels: string[];
}

export interface UnwrappedExpression {
  type: 'unwrapped';
  expression: LogExpression;
  field: UnwrapField;
  duration: Duration;
  offset?: Duration;
}

export interface UnwrapField {
  field: string;
  conversion?: 'bytes' | 'duration' | 'duration_seconds';
}

// Parser result types
export interface ParseResult {
  valid: boolean;
  ast?: LogQLAST | null;
  error?: string;
  suggestions?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}

export interface ValidationError {
  type: 'SYNTAX' | 'PIPELINE' | 'DURATION' | 'LABEL' | 'PARSER' | 'FUNCTION';
  message: string;
  suggestion?: string;
  line?: number;
  column?: number;
}

export interface ValidationWarning {
  type: 'PERFORMANCE' | 'DEPRECATED' | 'STYLE';
  message: string;
  suggestion?: string;
}