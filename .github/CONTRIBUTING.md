# Contributing to Log Correlator

Thank you for your interest in contributing to Log Correlator! We welcome contributions from the community and are grateful for any help you can provide.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Community](#community)

## Code of Conduct

This project adheres to a Code of Conduct that all contributors are expected to follow. Please be respectful and professional in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/log-correlator.git
   cd log-correlator
   ```
3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/liquescent/log-correlator.git
   ```
4. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Setup

### Prerequisites

- Node.js 18+ (we recommend using [nvm](https://github.com/nvm-sh/nvm))
- npm 9+
- Git

### Installation

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Start development mode
node tools/dev.js --test --lint
```

### Project Structure

```
log-correlator/
├── packages/
│   ├── core/                 # Core correlation engine
│   ├── query-parser/          # Query language parser
│   ├── adapters/
│   │   ├── loki/             # Loki adapter
│   │   └── graylog/          # Graylog adapter
│   └── examples/             # Usage examples
├── docs/                     # Documentation
├── tools/                    # Development tools
└── .github/                  # GitHub configuration
```

## How to Contribute

### Reporting Bugs

1. **Check existing issues** to avoid duplicates
2. **Create a new issue** using the bug report template
3. **Provide detailed information**:
   - Clear description of the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details
   - Code samples if applicable

### Suggesting Features

1. **Check existing issues and discussions**
2. **Open a discussion** for major features
3. **Create a feature request** issue with:
   - Problem statement
   - Proposed solution
   - Use cases
   - Example code

### Submitting Code

1. **Pick an issue** or create one for your change
2. **Follow the development setup** above
3. **Write your code** following our standards
4. **Add tests** for your changes
5. **Update documentation** if needed
6. **Submit a pull request**

## Pull Request Process

### Before Submitting

- [ ] Code follows our coding standards
- [ ] All tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Documentation is updated
- [ ] Commit messages follow conventional commits

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]

[optional footer(s)]
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes
- `refactor`: Code refactoring
- `perf`: Performance improvement
- `test`: Test changes
- `build`: Build system changes
- `ci`: CI/CD changes
- `chore`: Other changes

**Examples:**

```bash
feat(core): add support for custom join functions
fix(loki): handle connection timeouts properly
docs(api): update correlation engine examples
perf(parser): optimize query parsing for large expressions
```

### PR Review Process

1. **Automated checks** run on all PRs:

   - Linting
   - Type checking
   - Unit tests
   - Integration tests
   - Security scanning
   - Performance benchmarks

2. **Code review** by maintainers:

   - Code quality
   - Architecture decisions
   - Performance implications
   - Security considerations

3. **Feedback and iteration**:

   - Address reviewer comments
   - Update PR as needed
   - Re-request review when ready

4. **Merge**:
   - Squash and merge for feature branches
   - PR title becomes the commit message

## Coding Standards

### TypeScript/JavaScript

```typescript
// Use clear, descriptive names
class CorrelationEngine { }  // ✓ Good
class CE { }                 // ✗ Bad

// Document public APIs
/**
 * Correlates log streams based on the provided query.
 * @param query - PromQL-style correlation query
 * @returns Async generator of correlated events
 */
async *correlate(query: string): AsyncGenerator<CorrelatedEvent> {
  // Implementation
}

// Use async/await over callbacks
async function fetchData() {  // ✓ Good
  const data = await api.get();
  return data;
}

// Handle errors properly
try {
  await riskyOperation();
} catch (error) {
  logger.error('Operation failed', { error });
  throw new CorrelationError('Failed to correlate', error);
}
```

### File Organization

- One class/interface per file
- Group related functionality
- Use index.ts for public exports
- Keep files under 500 lines

### Testing

```javascript
describe("CorrelationEngine", () => {
  describe("correlate", () => {
    it("should correlate events with matching join keys", async () => {
      // Arrange
      const engine = new CorrelationEngine();
      const query = "test query";

      // Act
      const results = [];
      for await (const event of engine.correlate(query)) {
        results.push(event);
      }

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0].joinKey).toBe("expected");
    });
  });
});
```

## Testing Guidelines

### Test Coverage

- Maintain >80% code coverage
- Test edge cases and error conditions
- Include integration tests for adapters
- Add performance tests for critical paths

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- correlation-engine.test.ts

# Run in watch mode
npm test -- --watch

# Run benchmarks
node tools/benchmark.js simple
```

### Writing Tests

1. **Unit tests** for individual functions/classes
2. **Integration tests** for component interactions
3. **E2E tests** for complete workflows
4. **Performance tests** for critical operations

## Documentation

### Code Documentation

- Document all public APIs with JSDoc
- Include usage examples
- Explain complex algorithms
- Note performance characteristics

### User Documentation

- Update README for new features
- Add examples to docs/
- Update API documentation
- Include troubleshooting tips

### Generating Docs

```bash
# Generate API documentation
npm run docs:generate

# Preview documentation
npm run docs:serve
```

## Community

### Getting Help

- **GitHub Discussions**: Ask questions and share ideas
- **Issues**: Report bugs and request features
- **Discord**: Join our community chat (if available)

### Ways to Contribute

- **Code**: Fix bugs, add features
- **Documentation**: Improve docs, add examples
- **Testing**: Write tests, report bugs
- **Reviews**: Review PRs, provide feedback
- **Support**: Help others in discussions

### Recognition

Contributors are recognized in:

- GitHub contributors page
- CHANGELOG.md for significant contributions
- Special mentions for security reports

## Development Tips

### Quick Commands

```bash
# Development mode with auto-reload
node tools/dev.js

# Run specific package tests
cd packages/core && npm test

# Check for dependency updates
npm outdated

# Update dependencies safely
npm update

# Clean and rebuild
npm run clean && npm run build
```

### Debugging

```javascript
// Enable debug logging
process.env.DEBUG = "log-correlator:*";

// Use debugger in tests
it("should work", async () => {
  debugger; // Set breakpoint
  const result = await someFunction();
});
```

### Performance

```bash
# Run benchmarks
node tools/benchmark.js simple --verbose

# Profile memory usage
node --inspect tools/benchmark.js

# Load testing
node tools/load-test.js --scenario complex
```

## Questions?

Feel free to:

- Open a GitHub Discussion
- Ask in issues
- Contact maintainers

Thank you for contributing to Log Correlator! 🎉
