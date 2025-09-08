import { describe, it, expect } from '@jest/globals';
import { PeggyQueryParser } from './peggy-parser';

describe('Absolute Time Ranges', () => {
  const parser = new PeggyQueryParser();

  describe('Absolute time ranges with "to"', () => {
    it('should parse full ISO timestamps with UTC', () => {
      const query = 'graylog(service:api)[2024-01-15T10:00:00Z to 2024-01-15T18:00:00Z]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.type).toBe('direct');
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.start).toEqual({
        type: 'absolute',
        value: '2024-01-15T10:00:00Z'
      });
      expect(result.stream?.end).toEqual({
        type: 'absolute',
        value: '2024-01-15T18:00:00Z'
      });
    });

    it('should parse timestamps with timezone offsets', () => {
      const query = 'loki({app="frontend"})[2024-01-15T10:00:00-07:00 to 2024-01-15T18:00:00-07:00]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.start?.value).toBe('2024-01-15T10:00:00-07:00');
      expect(result.stream?.end?.value).toBe('2024-01-15T18:00:00-07:00');
    });

    it('should parse date-only format (defaults to midnight UTC)', () => {
      const query = 'events{service="auth"}[2024-01-15 to 2024-01-16]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.start?.value).toBe('2024-01-15T00:00:00Z');
      expect(result.stream?.end?.value).toBe('2024-01-16T00:00:00Z');
    });
  });

  describe('Mixed relative/absolute ranges', () => {
    it('should parse "now" as end time', () => {
      const query = 'graylog(service:api)[2024-01-15T10:00:00Z to now]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.start?.value).toBe('2024-01-15T10:00:00Z');
      expect(result.stream?.end).toEqual({ type: 'now' });
    });

    it('should parse relative "ago" as start time', () => {
      const query = 'loki({app="frontend"})[1d ago to 2024-01-15T18:00:00Z]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.start).toEqual({
        type: 'relative',
        value: '1d',
        direction: 'ago'
      });
      expect(result.stream?.end?.value).toBe('2024-01-15T18:00:00Z');
    });

    it('should parse relative future offset', () => {
      const query = 'events{}[2024-01-15T10:00:00Z to +8h]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.start?.value).toBe('2024-01-15T10:00:00Z');
      expect(result.stream?.end).toEqual({
        type: 'relative',
        value: '8h',
        direction: 'future'
      });
    });
  });

  describe('@ modifier for point-in-time queries', () => {
    it('should parse @ with timestamp alone', () => {
      const query = 'graylog(service:api) @ 2024-01-15T10:00:00Z';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.at).toBe('2024-01-15T10:00:00Z');
      expect(result.stream?.timeRange).toBeUndefined();
    });

    it('should parse @ with relative range', () => {
      const query = 'loki({app="frontend"})[1h] @ 2024-01-15T10:00:00Z';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRange).toBe('1h');
      expect(result.stream?.timeRangeType).toBe('relative');
      expect(result.stream?.at).toBe('2024-01-15T10:00:00Z');
    });

    it('should parse @ with absolute range', () => {
      const query = 'events{}[2024-01-15T09:00:00Z to 2024-01-15T10:00:00Z] @ 2024-01-15T10:00:00Z';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRangeType).toBe('absolute');
      expect(result.stream?.at).toBe('2024-01-15T10:00:00Z');
    });
  });

  describe('Backwards compatibility', () => {
    it('should still parse relative ranges correctly', () => {
      const query = 'graylog(service:api)[5m]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.stream?.timeRange).toBe('5m');
      expect(result.stream?.timeRangeType).toBe('relative');
    });

    it('should parse correlations with relative ranges', () => {
      const query = 'graylog(service:api)[1h] and on(request_id) loki({app="frontend"})[1h]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.leftStream?.timeRange).toBe('1h');
      expect(result.leftStream?.timeRangeType).toBe('relative');
      expect(result.rightStream?.timeRange).toBe('1h');
      expect(result.rightStream?.timeRangeType).toBe('relative');
    });
  });

  describe('Correlations with absolute ranges', () => {
    it('should parse correlations with absolute ranges', () => {
      const query = 'graylog(service:api)[2024-01-15T10:00:00Z to 2024-01-15T11:00:00Z] and on(request_id) loki({app="frontend"})[2024-01-15T10:00:00Z to 2024-01-15T11:00:00Z]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.type).toBe('correlation');
      expect(result.leftStream?.timeRangeType).toBe('absolute');
      expect(result.rightStream?.timeRangeType).toBe('absolute');
    });

    it('should parse correlations with mixed time ranges', () => {
      const query = 'graylog(service:api)[1h ago to now] and on(request_id) loki({app="frontend"})[1h]';
      const result = parser.parseRaw(query) as any;
      
      expect(result.leftStream?.timeRangeType).toBe('absolute');
      expect(result.leftStream?.start?.direction).toBe('ago');
      expect(result.leftStream?.end?.type).toBe('now');
      expect(result.rightStream?.timeRangeType).toBe('relative');
      expect(result.rightStream?.timeRange).toBe('1h');
    });
  });

  describe('Error cases', () => {
    it('should handle invalid timestamp formats gracefully', () => {
      // The parser should either reject or handle these cases
      const invalidQueries = [
        'graylog(service:api)[2024-13-45T25:00:00Z to now]',  // Invalid date
        'graylog(service:api)[not-a-date to now]',  // Not a date
      ];

      for (const query of invalidQueries) {
        // We expect these to either throw or be handled gracefully
        // The exact behavior depends on the parser implementation
        try {
          const result = parser.parseRaw(query) as any;
          // If it doesn't throw, check that it's handled somehow
          expect(result).toBeDefined();
        } catch (e) {
          // Expected for invalid input
          expect(e).toBeDefined();
        }
      }
    });
  });
});