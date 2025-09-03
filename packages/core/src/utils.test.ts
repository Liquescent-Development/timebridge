import {
  parseTimeWindow,
  formatDuration,
  generateCorrelationId,
  isValidTimestamp,
  extractLabels,
  debounce,
} from "./utils";

describe("Utils", () => {
  describe("parseTimeWindow", () => {
    it("should parse milliseconds correctly", () => {
      expect(parseTimeWindow("50ms")).toBe(50);
      expect(parseTimeWindow("100ms")).toBe(100);
      expect(parseTimeWindow("1000ms")).toBe(1000);
    });

    it("should parse seconds correctly", () => {
      expect(parseTimeWindow("30s")).toBe(30000);
      expect(parseTimeWindow("1s")).toBe(1000);
      expect(parseTimeWindow("120s")).toBe(120000);
    });

    it("should parse minutes correctly", () => {
      expect(parseTimeWindow("5m")).toBe(300000);
      expect(parseTimeWindow("1m")).toBe(60000);
      expect(parseTimeWindow("30m")).toBe(1800000);
    });

    it("should parse hours correctly", () => {
      expect(parseTimeWindow("1h")).toBe(3600000);
      expect(parseTimeWindow("2h")).toBe(7200000);
      expect(parseTimeWindow("24h")).toBe(86400000);
    });

    it("should parse days correctly", () => {
      expect(parseTimeWindow("1d")).toBe(86400000);
      expect(parseTimeWindow("7d")).toBe(604800000);
    });

    it("should throw error for invalid format", () => {
      expect(() => parseTimeWindow("invalid")).toThrow(
        "Invalid time window format"
      );
      expect(() => parseTimeWindow("5")).toThrow("Invalid time window format");
      expect(() => parseTimeWindow("5x")).toThrow("Invalid time window format");
    });
  });

  describe("formatDuration", () => {
    it("should format milliseconds", () => {
      expect(formatDuration(500)).toBe("500ms");
      expect(formatDuration(999)).toBe("999ms");
    });

    it("should format seconds", () => {
      expect(formatDuration(1000)).toBe("1s");
      expect(formatDuration(30000)).toBe("30s");
      expect(formatDuration(59999)).toBe("59s");
    });

    it("should format minutes", () => {
      expect(formatDuration(60000)).toBe("1m");
      expect(formatDuration(300000)).toBe("5m");
      expect(formatDuration(3599999)).toBe("59m");
    });

    it("should format hours", () => {
      expect(formatDuration(3600000)).toBe("1h");
      expect(formatDuration(7200000)).toBe("2h");
      expect(formatDuration(86400000)).toBe("24h");
    });
  });

  describe("generateCorrelationId", () => {
    it("should generate unique IDs", () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(id1).toMatch(/^corr_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^corr_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it("should include timestamp", () => {
      const before = Date.now();
      const id = generateCorrelationId();
      const after = Date.now();

      const timestamp = parseInt(id.split("_")[1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("isValidTimestamp", () => {
    it("should validate ISO timestamps", () => {
      expect(isValidTimestamp("2025-08-10T10:30:00.123Z")).toBe(true);
      expect(isValidTimestamp("2025-08-10T10:30:00Z")).toBe(true);
      expect(isValidTimestamp("2025-08-10T10:30:00+00:00")).toBe(true);
    });

    it("should reject invalid timestamps", () => {
      expect(isValidTimestamp("invalid")).toBe(false);
      expect(isValidTimestamp("2025-13-01T00:00:00Z")).toBe(false); // Invalid month
      expect(isValidTimestamp("not-a-date")).toBe(false);
    });
  });

  describe("extractLabels", () => {
    it("should extract key=value pairs", () => {
      const log = "level=info service=frontend request_id=abc123 status=200";
      const labels = extractLabels(log);

      expect(labels).toEqual({
        level: "info",
        service: "frontend",
        request_id: "abc123",
        status: "200",
      });
    });

    it("should handle quoted values", () => {
      const log = "message=\"hello world\" service='test service' id=123";
      const labels = extractLabels(log);

      expect(labels).toEqual({
        message: "hello world",
        service: "test service",
        id: "123",
      });
    });

    it("should handle logs without labels", () => {
      const log = "This is just a plain log message";
      const labels = extractLabels(log);

      expect(labels).toEqual({});
    });
  });

  describe("debounce", () => {
    jest.useFakeTimers();

    it("should debounce function calls", () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn("first");
      debouncedFn("second");
      debouncedFn("third");

      expect(mockFn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith("third");
    });

    it("should reset timer on each call", () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn("first");
      jest.advanceTimersByTime(50);

      debouncedFn("second");
      jest.advanceTimersByTime(50);

      expect(mockFn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith("second");
    });
  });
});
