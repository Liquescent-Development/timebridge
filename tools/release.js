#!/usr/bin/env node

/**
 * Release script for log-correlator packages
 * Handles versioning, npm publishing, and GitHub releases
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const semver = require("semver");

const ROOT_DIR = path.join(__dirname, "..");

// Release configuration
const RELEASE_CONFIG = {
  dryRun: process.argv.includes("--dry-run"),
  skipTests: process.argv.includes("--skip-tests"),
  skipBuild: process.argv.includes("--skip-build"),
  prerelease: process.argv.includes("--prerelease"),
  npm: !process.argv.includes("--no-npm"),
  github: !process.argv.includes("--no-github"),
  verbose: process.argv.includes("--verbose"),
};

// Get release type from arguments
const RELEASE_TYPE =
  process.argv.find((arg) =>
    [
      "major",
      "minor",
      "patch",
      "premajor",
      "preminor",
      "prepatch",
      "prerelease",
    ].includes(arg)
  ) || "patch";

// Logging utilities
const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  verbose: (msg) => RELEASE_CONFIG.verbose && console.log(`   ${msg}`),
};

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Prompt user for confirmation
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Execute command
function exec(command, options = {}) {
  try {
    log.verbose(`Executing: ${command}`);

    if (RELEASE_CONFIG.dryRun && command.includes("npm publish")) {
      log.info(`[DRY RUN] Would execute: ${command}`);
      return "";
    }

    const result = execSync(command, {
      cwd: ROOT_DIR,
      stdio: RELEASE_CONFIG.verbose ? "inherit" : "pipe",
      ...options,
    });

    return result?.toString().trim();
  } catch (error) {
    log.error(`Command failed: ${command}`);
    if (!RELEASE_CONFIG.verbose) {
      console.error(error.message);
    }
    throw error;
  }
}

// Get all packages
function getPackages() {
  const packages = [];
  const workspaces = JSON.parse(exec("npm ls --json --depth=0") || "{}");

  // Parse workspace packages
  if (workspaces.dependencies) {
    Object.entries(workspaces.dependencies).forEach(([name, info]) => {
      if (info.resolved?.startsWith("file:")) {
        const pkgPath = path.join(ROOT_DIR, info.resolved.replace("file:", ""));
        const pkgJson = JSON.parse(
          fs.readFileSync(path.join(pkgPath, "package.json"), "utf8")
        );

        packages.push({
          name,
          path: pkgPath,
          version: pkgJson.version,
          json: pkgJson,
          private: pkgJson.private,
        });
      }
    });
  }

  return packages.filter((pkg) => !pkg.private);
}

// Check Git status
function checkGitStatus() {
  log.info("Checking Git status...");

  const status = exec("git status --porcelain");
  if (status) {
    log.error(
      "Working directory is not clean. Please commit or stash changes."
    );
    console.log(status);
    process.exit(1);
  }

  // Check we're on main branch
  const branch = exec("git branch --show-current");
  if (branch !== "main" && !RELEASE_CONFIG.dryRun) {
    log.warn(`Not on main branch (current: ${branch})`);

    if (process.env.CI !== "true") {
      const answer = prompt("Continue anyway? (y/N) ");
      if (answer.toLowerCase() !== "y") {
        process.exit(1);
      }
    }
  }

  log.success("Git status OK");
}

// Run tests
function runTests() {
  if (RELEASE_CONFIG.skipTests) {
    log.warn("Skipping tests");
    return;
  }

  log.info("Running tests...");

  try {
    exec("npm test");
    log.success("Tests passed");
  } catch (error) {
    log.error("Tests failed. Fix issues before releasing.");
    process.exit(1);
  }
}

// Build packages
function buildPackages() {
  if (RELEASE_CONFIG.skipBuild) {
    log.warn("Skipping build");
    return;
  }

  log.info("Building packages...");

  try {
    exec("node tools/build.js --clean --minify");
    log.success("Build complete");
  } catch (error) {
    log.error("Build failed");
    process.exit(1);
  }
}

// Update package versions
function updateVersions(packages, newVersion) {
  log.info(`Updating versions to ${newVersion}...`);

  packages.forEach((pkg) => {
    const pkgJsonPath = path.join(pkg.path, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

    // Update version
    pkgJson.version = newVersion;

    // Update dependencies to other workspace packages
    ["dependencies", "devDependencies", "peerDependencies"].forEach(
      (depType) => {
        if (pkgJson[depType]) {
          Object.keys(pkgJson[depType]).forEach((dep) => {
            if (packages.find((p) => p.name === dep)) {
              pkgJson[depType][dep] = `^${newVersion}`;
              log.verbose(`Updated ${dep} in ${pkg.name} ${depType}`);
            }
          });
        }
      }
    );

    // Write updated package.json
    if (!RELEASE_CONFIG.dryRun) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
    }

    log.verbose(`Updated ${pkg.name} to ${newVersion}`);
  });

  // Update root package.json
  const rootPkgPath = path.join(ROOT_DIR, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  rootPkg.version = newVersion;

  if (!RELEASE_CONFIG.dryRun) {
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
  }

  log.success(`Updated all packages to ${newVersion}`);
}

// Generate changelog
function generateChangelog(version) {
  log.info("Generating changelog...");

  const changelogPath = path.join(ROOT_DIR, "CHANGELOG.md");
  const date = new Date().toISOString().split("T")[0];

  // Get commit messages since last tag
  let lastTag;
  try {
    lastTag = exec("git describe --tags --abbrev=0");
  } catch {
    lastTag = "HEAD~20"; // If no tags, use last 20 commits
  }

  const commits = exec(`git log ${lastTag}..HEAD --pretty=format:"- %s (%h)"`);

  // Parse commits by type
  const changes = {
    breaking: [],
    features: [],
    fixes: [],
    other: [],
  };

  commits.split("\n").forEach((commit) => {
    if (commit.includes("BREAKING")) {
      changes.breaking.push(commit);
    } else if (commit.match(/^- (feat|feature)/i)) {
      changes.features.push(commit);
    } else if (commit.match(/^- (fix|bugfix)/i)) {
      changes.fixes.push(commit);
    } else if (commit.trim()) {
      changes.other.push(commit);
    }
  });

  // Build changelog entry
  let entry = `## [${version}] - ${date}\n\n`;

  if (changes.breaking.length > 0) {
    entry += "### ⚠️ Breaking Changes\n";
    entry += changes.breaking.join("\n") + "\n\n";
  }

  if (changes.features.length > 0) {
    entry += "### ✨ Features\n";
    entry += changes.features.join("\n") + "\n\n";
  }

  if (changes.fixes.length > 0) {
    entry += "### 🐛 Bug Fixes\n";
    entry += changes.fixes.join("\n") + "\n\n";
  }

  if (changes.other.length > 0) {
    entry += "### 📝 Other Changes\n";
    entry += changes.other.join("\n") + "\n\n";
  }

  // Update changelog file
  if (fs.existsSync(changelogPath)) {
    const existingChangelog = fs.readFileSync(changelogPath, "utf8");
    const updatedChangelog = existingChangelog.replace(
      "# Changelog\n",
      `# Changelog\n\n${entry}`
    );

    if (!RELEASE_CONFIG.dryRun) {
      fs.writeFileSync(changelogPath, updatedChangelog);
    }
  } else {
    const newChangelog = `# Changelog\n\n${entry}`;

    if (!RELEASE_CONFIG.dryRun) {
      fs.writeFileSync(changelogPath, newChangelog);
    }
  }

  log.success("Changelog updated");
  return entry;
}

// Commit version changes
function commitChanges(version) {
  log.info("Committing changes...");

  if (RELEASE_CONFIG.dryRun) {
    log.info("[DRY RUN] Would commit version changes");
    return;
  }

  exec("git add -A");
  exec(`git commit -m "chore: release v${version}"`);
  exec(`git tag -a v${version} -m "Release v${version}"`);

  log.success(`Committed and tagged v${version}`);
}

// Push to Git
function pushToGit() {
  log.info("Pushing to Git...");

  if (RELEASE_CONFIG.dryRun) {
    log.info("[DRY RUN] Would push to Git");
    return;
  }

  exec("git push origin main");
  exec("git push origin --tags");

  log.success("Pushed to Git");
}

// Publish to npm
async function publishToNpm(packages) {
  if (!RELEASE_CONFIG.npm) {
    log.warn("Skipping npm publish");
    return;
  }

  log.info("Publishing to npm...");

  // Check npm authentication
  try {
    exec("npm whoami");
  } catch {
    log.error('Not logged in to npm. Run "npm login" first.');
    process.exit(1);
  }

  // Publish each package
  for (const pkg of packages) {
    if (pkg.private) {
      log.verbose(`Skipping private package: ${pkg.name}`);
      continue;
    }

    log.info(`Publishing ${pkg.name}...`);

    const publishCmd = RELEASE_CONFIG.prerelease
      ? `npm publish --tag next`
      : `npm publish`;

    try {
      exec(publishCmd, { cwd: pkg.path });
      log.success(`Published ${pkg.name}`);

      // Wait a bit between publishes
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      log.error(`Failed to publish ${pkg.name}`);
      throw error;
    }
  }

  log.success("All packages published to npm");
}

// Create GitHub release
function createGitHubRelease(version, changelog) {
  if (!RELEASE_CONFIG.github) {
    log.warn("Skipping GitHub release");
    return;
  }

  log.info("Creating GitHub release...");

  if (RELEASE_CONFIG.dryRun) {
    log.info("[DRY RUN] Would create GitHub release");
    return;
  }

  const releaseNotes = changelog
    .replace(/## \[.*?\] - \d{4}-\d{2}-\d{2}\n/, "") // Remove header
    .trim();

  try {
    // Use GitHub CLI if available
    exec("gh --version", { stdio: "ignore" });

    const prerelease = RELEASE_CONFIG.prerelease ? "--prerelease" : "";
    exec(
      `gh release create v${version} --title "v${version}" --notes "${releaseNotes}" ${prerelease}`
    );

    log.success("GitHub release created");
  } catch {
    log.warn("GitHub CLI not found. Create release manually at:");
    console.log(
      `https://github.com/liquescent/log-correlator/releases/new?tag=v${version}`
    );
  }
}

// Main release process
async function release() {
  console.log("🚀 Releasing log-correlator packages\n");

  if (RELEASE_CONFIG.dryRun) {
    log.warn("DRY RUN MODE - No changes will be made");
  }

  try {
    // Check Git status
    checkGitStatus();

    // Get packages
    const packages = getPackages();
    if (packages.length === 0) {
      log.error("No packages found to release");
      process.exit(1);
    }

    // Get current version
    const currentVersion = packages[0].version;
    log.info(`Current version: ${currentVersion}`);

    // Calculate new version
    const newVersion = semver.inc(currentVersion, RELEASE_TYPE);
    log.info(`New version: ${newVersion} (${RELEASE_TYPE})`);

    // Confirm release
    if (!RELEASE_CONFIG.dryRun && process.env.CI !== "true") {
      console.log("\nPackages to release:");
      packages.forEach((pkg) => console.log(`  - ${pkg.name}`));

      const answer = await prompt(`\nRelease v${newVersion}? (y/N) `);
      if (answer.toLowerCase() !== "y") {
        log.info("Release cancelled");
        process.exit(0);
      }
    }

    // Run tests
    runTests();

    // Build packages
    buildPackages();

    // Update versions
    updateVersions(packages, newVersion);

    // Generate changelog
    const changelog = generateChangelog(newVersion);

    // Commit changes
    commitChanges(newVersion);

    // Push to Git
    pushToGit();

    // Publish to npm
    await publishToNpm(packages);

    // Create GitHub release
    createGitHubRelease(newVersion, changelog);

    console.log(`\n✨ Successfully released v${newVersion}`);

    if (RELEASE_CONFIG.dryRun) {
      console.log("\n📝 This was a dry run. No changes were made.");
    }
  } catch (error) {
    log.error("Release failed");
    console.error(error);
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Handle CLI
if (require.main === module) {
  // Show help
  if (process.argv.includes("--help")) {
    console.log(`
Log Correlator Release Script

Usage: node tools/release.js [version] [options]

Version types:
  major           Bump major version (1.0.0 -> 2.0.0)
  minor           Bump minor version (1.0.0 -> 1.1.0)
  patch           Bump patch version (1.0.0 -> 1.0.1) [default]
  premajor        Pre-release major (1.0.0 -> 2.0.0-0)
  preminor        Pre-release minor (1.0.0 -> 1.1.0-0)
  prepatch        Pre-release patch (1.0.0 -> 1.0.1-0)
  prerelease      Bump pre-release (1.0.0-0 -> 1.0.0-1)

Options:
  --dry-run       Run without making changes
  --skip-tests    Skip running tests
  --skip-build    Skip building packages
  --prerelease    Mark as pre-release
  --no-npm        Skip npm publishing
  --no-github     Skip GitHub release
  --verbose       Show detailed output
  --help          Show this help message

Examples:
  node tools/release.js                    # Patch release
  node tools/release.js minor              # Minor release
  node tools/release.js major --dry-run    # Dry run major release
  node tools/release.js prerelease         # Pre-release
    `);
    process.exit(0);
  }

  // Check for required dependencies
  try {
    require("semver");
  } catch {
    log.error("Missing dependency. Run: npm install semver");
    process.exit(1);
  }

  // Run release
  release();
}

module.exports = { release };
