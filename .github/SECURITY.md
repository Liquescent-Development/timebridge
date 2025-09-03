# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible for receiving such patches depends on the CVSS v3.0 Rating:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of our software seriously. If you believe you have found a security vulnerability in log-correlator, please report it to us as described below.

### Please do NOT:

- Open a public GitHub issue for security vulnerabilities
- Post about the vulnerability on social media
- Attempt to exploit the vulnerability on production systems

### Please DO:

1. **Email us directly** at: security@liquescent.io (or create a private security advisory on GitHub)

2. **Include the following information**:

   - Type of vulnerability (e.g., XSS, SQL Injection, RCE)
   - Full paths of source file(s) related to the vulnerability
   - The location of the affected source code (tag/branch/commit or direct URL)
   - Any special configuration required to reproduce the issue
   - Step-by-step instructions to reproduce the issue
   - Proof-of-concept or exploit code (if possible)
   - Impact of the issue, including how an attacker might exploit it

3. **Allow us time to respond** before public disclosure:
   - We will acknowledge receipt within 48 hours
   - We will provide a detailed response within 7 days
   - We will work on a fix and coordinate the release with you

## Security Best Practices

When using log-correlator in production:

### 1. Input Validation

Always validate and sanitize log queries before processing:

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");

// Validate query before execution
function safeCorrelate(engine, userQuery) {
  // Sanitize user input
  const sanitized = userQuery
    .replace(/[;<>]/g, "") // Remove potential injection characters
    .slice(0, 1000); // Limit query length

  // Validate query syntax
  if (!engine.validateQuery(sanitized)) {
    throw new Error("Invalid query syntax");
  }

  return engine.correlate(sanitized);
}
```

### 2. Resource Limits

Set appropriate resource limits to prevent DoS:

```javascript
const engine = new CorrelationEngine({
  maxEvents: 1000, // Limit events in memory
  maxMemoryMB: 50, // Memory limit
  timeout: 30000, // Query timeout
  bufferSize: 100, // Small buffer to limit resource usage
});
```

### 3. Authentication & Authorization

Always implement proper authentication for data sources:

```javascript
// Use authentication tokens
const lokiAdapter = new LokiAdapter({
  url: process.env.LOKI_URL,
  authToken: process.env.LOKI_AUTH_TOKEN, // Keep tokens in env vars
  headers: {
    "X-Scope-OrgID": process.env.ORG_ID,
  },
});

// Never commit credentials
const graylogAdapter = new GraylogAdapter({
  url: process.env.GRAYLOG_URL,
  apiToken: process.env.GRAYLOG_API_TOKEN, // Use API tokens over passwords
});
```

### 4. Network Security

Use HTTPS/TLS for all connections:

```javascript
const adapter = new LokiAdapter({
  url: "https://loki.example.com", // Always use HTTPS
  rejectUnauthorized: true, // Verify SSL certificates
  timeout: 10000, // Set reasonable timeouts
});
```

### 5. Logging and Monitoring

Implement security logging:

```javascript
engine.on("error", (error) => {
  // Log security-relevant errors
  if (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN") {
    logger.security("Authentication failure", {
      timestamp: new Date(),
      error: error.message,
      source: error.source,
    });
  }
});

// Monitor for suspicious patterns
engine.on("correlationFound", (correlation) => {
  if (correlation.events.length > 1000) {
    logger.warn("Large correlation detected", {
      correlationId: correlation.correlationId,
      eventCount: correlation.events.length,
    });
  }
});
```

## Security Checklist

Before deploying to production:

- [ ] All dependencies are up to date (`npm audit`)
- [ ] Input validation is implemented
- [ ] Resource limits are configured
- [ ] Authentication is required for all data sources
- [ ] HTTPS/TLS is used for all connections
- [ ] Sensitive data is not logged
- [ ] Error messages don't leak sensitive information
- [ ] Security headers are configured (if using HTTP server)
- [ ] Rate limiting is implemented (if exposed to internet)
- [ ] Monitoring and alerting is configured

## Dependencies

We regularly update dependencies to address security vulnerabilities. To check for vulnerabilities in your installation:

```bash
# Check for known vulnerabilities
npm audit

# Update to latest secure versions
npm audit fix

# Force updates if needed (use with caution)
npm audit fix --force
```

## Security Updates

Security updates will be released as:

- **PATCH** version for low to medium severity issues
- **MINOR** version for high severity issues that require API changes
- **MAJOR** version only if breaking changes are absolutely necessary

Subscribe to our security advisories by watching the repository with "Security alerts" enabled.

## Attribution

We would like to thank the following individuals for responsibly disclosing security issues:

- (List will be updated as vulnerabilities are reported and fixed)

## Contact

For any security-related questions, contact: security@liquescent.io
