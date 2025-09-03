#!/usr/bin/env node

/**
 * Development helper script for log-correlator
 * Provides watch mode, auto-reload, and development utilities
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

const ROOT_DIR = path.join(__dirname, "..");

// Development configuration
const CONFIG = {
  watch: !process.argv.includes("--no-watch"),
  test: process.argv.includes("--test"),
  lint: process.argv.includes("--lint"),
  typecheck: process.argv.includes("--typecheck"),
  verbose: process.argv.includes("--verbose"),
};

// Active processes
const processes = new Map();

// Logging utilities
const log = {
  info: (msg) => console.log(`\n💡 ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  change: (msg) => console.log(`🔄 ${msg}`),
  verbose: (msg) => CONFIG.verbose && console.log(`   ${msg}`),
};

// Spawn a process
function spawnProcess(name, command, args = [], options = {}) {
  // Kill existing process if running
  killProcess(name);

  log.verbose(`Starting ${name}: ${command} ${args.join(" ")}`);

  const proc = spawn(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: true,
    ...options,
  });

  proc.on("error", (error) => {
    log.error(`${name} error: ${error.message}`);
  });

  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log.error(`${name} exited with code ${code}`);
    }
    processes.delete(name);
  });

  processes.set(name, proc);
  return proc;
}

// Kill a process
function killProcess(name) {
  const proc = processes.get(name);
  if (proc) {
    proc.kill();
    processes.delete(name);
  }
}

// Kill all processes
function killAll() {
  processes.forEach((proc, name) => {
    log.verbose(`Stopping ${name}`);
    proc.kill();
  });
  processes.clear();
}

// Start TypeScript compiler in watch mode
function startTypeScript() {
  log.info("Starting TypeScript compiler in watch mode...");
  spawnProcess("tsc", "npx", ["tsc", "--build", "--watch"]);
}

// Start test runner in watch mode
function startTests() {
  if (!CONFIG.test) return;

  log.info("Starting test runner in watch mode...");
  spawnProcess("jest", "npx", ["jest", "--watch", "--coverage"]);
}

// Run linting
function runLint() {
  if (!CONFIG.lint) return;

  log.info("Running linter...");
  spawnProcess("eslint", "npx", ["eslint", ".", "--ext", ".ts,.js"]);
}

// File watcher setup
function setupWatcher() {
  if (!CONFIG.watch) return;

  log.info("Setting up file watcher...");

  const watcher = chokidar.watch(
    [
      "packages/**/*.ts",
      "packages/**/*.js",
      "packages/**/*.json",
      "!packages/**/dist/**",
      "!packages/**/lib/**",
      "!packages/**/node_modules/**",
    ],
    {
      cwd: ROOT_DIR,
      ignored: /(^|[\\/\\])\\../, // Ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    }
  );

  // Debounce mechanism
  let timeout;
  const debounce = (fn, delay = 1000) => {
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), delay);
    };
  };

  // Handle file changes
  const handleChange = debounce((path) => {
    log.change(`File changed: ${path}`);

    // Run appropriate actions based on file type
    if (path.endsWith(".ts")) {
      // TypeScript will recompile automatically
      log.verbose("TypeScript recompiling...");
    }

    if (CONFIG.lint && (path.endsWith(".ts") || path.endsWith(".js"))) {
      runLint();
    }

    if (CONFIG.test && path.includes(".test.")) {
      log.verbose("Test file changed, Jest will re-run...");
    }
  });

  watcher
    .on("change", handleChange)
    .on("add", handleChange)
    .on("unlink", (path) => log.verbose(`File deleted: ${path}`))
    .on("error", (error) => log.error(`Watcher error: ${error}`));

  return watcher;
}

// Development server for examples
function startExampleServer() {
  const examplesDir = path.join(ROOT_DIR, "packages", "examples");
  if (!fs.existsSync(examplesDir)) return;

  log.info("Starting example server...");

  const express = require("express");
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Serve static files
  app.use(express.static(examplesDir));

  // API endpoint for testing
  app.get("/api/correlate", async (req, res) => {
    try {
      const { CorrelationEngine } = require(path.join(
        ROOT_DIR,
        "packages/core/dist"
      ));
      const engine = new CorrelationEngine();

      const query = req.query.q || 'loki({service="test"})[5m]';
      const results = [];

      for await (const correlation of engine.correlate(query)) {
        results.push(correlation);
        if (results.length >= 10) break;
      }

      res.json({ query, results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const server = app.listen(PORT, () => {
    log.success(`Example server running at http://localhost:${PORT}`);
  });

  processes.set("server", server);
}

// Display development dashboard
function displayDashboard() {
  console.clear();
  console.log("╔════════════════════════════════════════╗");
  console.log("║     Log Correlator Development Mode    ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();
  console.log("📊 Active Processes:");
  processes.forEach((proc, name) => {
    console.log(`   • ${name}: running`);
  });
  console.log();
  console.log("⌨️  Commands:");
  console.log("   r - Restart all processes");
  console.log("   t - Run tests");
  console.log("   l - Run linter");
  console.log("   c - Clear console");
  console.log("   q - Quit");
  console.log();
  console.log("👀 Watching for changes...");
  console.log();
}

// Handle keyboard input
function setupKeyboardInput() {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key) => {
    switch (key) {
      case "r":
      case "R":
        log.info("Restarting all processes...");
        killAll();
        startAll();
        break;

      case "t":
      case "T":
        runTests();
        break;

      case "l":
      case "L":
        runLint();
        break;

      case "c":
      case "C":
        displayDashboard();
        break;

      case "q":
      case "Q":
      case "\u0003": // Ctrl+C
        shutdown();
        break;
    }
  });
}

// Run tests once
function runTests() {
  log.info("Running tests...");
  spawnProcess("test-once", "npm", ["test"]);
}

// Start all development processes
function startAll() {
  startTypeScript();
  startTests();
  startExampleServer();
  setupWatcher();
}

// Graceful shutdown
function shutdown() {
  log.info("Shutting down development mode...");
  killAll();
  process.exit(0);
}

// Main function
function main() {
  // Setup signal handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Display dashboard
  displayDashboard();

  // Start all processes
  startAll();

  // Setup keyboard input
  setupKeyboardInput();

  // Keep process alive
  process.stdin.resume();
}

// CLI handling
if (require.main === module) {
  if (process.argv.includes("--help")) {
    console.log(`
Log Correlator Development Mode

Usage: node tools/dev.js [options]

Options:
  --no-watch     Disable file watching
  --test         Enable test runner in watch mode
  --lint         Enable linting on file changes
  --typecheck    Enable type checking
  --verbose      Show detailed output
  --help         Show this help message

Keyboard Commands (during execution):
  r - Restart all processes
  t - Run tests
  l - Run linter
  c - Clear console
  q - Quit

Examples:
  node tools/dev.js
  node tools/dev.js --test --lint
  node tools/dev.js --verbose
    `);
    process.exit(0);
  }

  // Check for required dev dependencies
  try {
    require("chokidar");
  } catch {
    log.error("Missing dev dependency. Run: npm install --save-dev chokidar");
    process.exit(1);
  }

  main();
}

module.exports = { spawnProcess, setupWatcher };
