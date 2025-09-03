# Real-Time Correlation Processing Tests

This document describes the comprehensive test suite created for real-time correlation processing in the StreamJoiner component of the log-correlator TypeScript package.

## Overview

The real-time correlation processing feature is designed to process correlations as events arrive instead of waiting for all streams to complete. The test suite in `/Users/kiener/code/log-correlator/packages/core/src/stream-joiner.test.ts` provides extensive coverage for this functionality.

## Test Architecture

### Helper Functions

1. **`createDelayedAsyncIterable<T>`**: Creates async iterables with configurable delays between events to simulate realistic streaming behavior
2. **`collectCorrelationsWithTiming`**: Collects correlations along with timing information to verify real-time emission behavior

### Test Categories

## 1. Immediate Correlation Emission Tests

These tests verify that correlations are emitted as soon as matches are found:

- **Immediate emission on match**: Verifies correlations are emitted quickly when both events for a join key arrive
- **Completion order**: Tests that correlations are emitted in order of completion, not arrival order
- **Concurrent matches**: Validates handling of multiple simultaneous correlations for different join keys

**Current Status**: Some tests are marked as `it.skip()` because they test future real-time behavior. The current implementation processes correlations in batch after streams complete.

## 2. Left Join Real-Time Emission Tests

Tests specific to left join (`or`) operations in real-time scenarios:

- **Partial correlation emission**: Verifies that partial correlations (left-only events) are emitted immediately
- **Late arrival handling**: Tests upgrading partial correlations to complete when right events arrive within tolerance

**Implementation Notes**: These tests validate the current batch behavior while providing guidance for real-time implementation.

## 3. Late-Arriving Events Tests

Tests for handling events that arrive outside expected timing windows:

- **Within tolerance window**: Events arriving within `lateTolerance` are included in correlations
- **Outside tolerance window**: Events arriving too late are rejected (currently skipped as it requires real-time implementation)
- **Out-of-order arrival**: Validates correct handling when events arrive out of timestamp order

## 4. Performance Tests

Comprehensive performance validation for streaming scenarios:

- **High-frequency streams**: Tests with 500 events at 1ms intervals to validate performance under load
- **Large event streams**: Tests with 200 events to ensure memory efficiency and throughput
- **Backpressure handling**: Simulates slow consumers to test graceful degradation under pressure

**Performance Expectations**:

- High-frequency tests complete within 5 seconds
- Memory usage remains bounded within configured limits
- No event loss under backpressure conditions

## 5. Edge Case Tests

Robust testing of boundary conditions and error scenarios:

- **Streams ending at different times**: One stream completes before the other
- **Empty streams**: One or both streams have no events
- **Temporal gaps**: Large time gaps between events in streams
- **Rapid successive events**: Multiple events with same join key arriving quickly
- **Concurrent load accuracy**: Maintains correlation accuracy under concurrent processing

## Implementation Guidance

### Current vs. Future Behavior

The test suite serves dual purposes:

1. **Current Implementation Testing**: Tests that pass validate the existing batch processing behavior
2. **Future Implementation Guidance**: Skipped tests provide specifications for real-time correlation processing

### Real-Time Implementation Requirements

When implementing real-time correlation processing, the following features should be added:

1. **Streaming Correlation Check**: Replace the commented-out correlation interval (lines 39-42 in stream-joiner.ts) with active correlation processing
2. **Immediate Emission**: Yield correlations as soon as matches are found, not after stream completion
3. **Late Tolerance Enforcement**: Reject events arriving outside the configured tolerance window
4. **Memory Management**: Implement sliding windows to prevent unbounded memory growth in long-running streams

### Test Activation

To activate the skipped tests for real-time implementation:

1. Change `it.skip()` to `it()` for real-time specific tests
2. Implement the real-time correlation logic in StreamJoiner
3. Ensure timing-sensitive tests meet the expected performance criteria

## Testing Patterns

### Streaming Simulation

Tests use configurable delays to simulate realistic streaming patterns:

```typescript
const leftEvents = [
  {
    item: createTestEvent("2025-08-13T10:00:00Z", {}, { request_id: "req1" }),
    delay: 10,
  },
  {
    item: createTestEvent("2025-08-13T10:00:02Z", {}, { request_id: "req2" }),
    delay: 100,
  },
];
```

### Timing Validation

Tests measure correlation emission timing to validate real-time behavior:

```typescript
const results = await collectCorrelationsWithTiming(
  joiner,
  leftStream,
  rightStream
);
expect(results[0].receivedAt).toBeLessThan(100); // Should emit quickly
```

### Concurrency Testing

Tests validate behavior under concurrent stream processing:

```typescript
// Simulate interleaved events from different streams
const leftEvents = [
  /* events with varying delays */
];
const rightEvents = [
  /* events with different timing */
];
```

## Benefits

This comprehensive test suite provides:

1. **Implementation Safety**: Ensures real-time implementation doesn't break existing functionality
2. **Performance Validation**: Verifies acceptable performance under various load conditions
3. **Edge Case Coverage**: Tests boundary conditions that could cause failures in production
4. **Documentation**: Tests serve as executable specifications for real-time behavior

## Future Enhancements

Potential test additions for advanced real-time features:

1. **Window-based processing**: Tests for sliding time windows
2. **Watermark processing**: Tests for late event handling with watermarks
3. **Stateful operations**: Tests for maintaining state across correlation windows
4. **Error recovery**: Tests for handling and recovering from processing errors
5. **Metrics and monitoring**: Tests for correlation processing metrics

This test suite provides a solid foundation for implementing and validating real-time correlation processing while maintaining high code quality and reliability standards.
