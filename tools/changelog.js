#!/usr/bin/env node

/**
 * Changelog generation tool for log-correlator
 * Generates and maintains CHANGELOG.md from git commits
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const CHANGELOG_PATH = path.join(ROOT_DIR, "CHANGELOG.md");

// Configuration
const CONFIG = {
  unreleased: process.argv.includes("--unreleased"),
  all: process.argv.includes("--all"),
  from: process.argv.find((arg) => arg.startsWith("--from="))?.split("=")[1],
  to:
    process.argv.find((arg) => arg.startsWith("--to="))?.split("=")[1] ||
    "HEAD",
  output:
    process.argv.find((arg) => arg.startsWith("--output="))?.split("=")[1] ||
    CHANGELOG_PATH,
  dryRun: process.argv.includes("--dry-run"),
  verbose: process.argv.includes("--verbose"),
  includeMerges: process.argv.includes("--include-merges"),
  noOther: process.argv.includes("--no-other"),
  template: process.argv
    .find((arg) => arg.startsWith("--template="))
    ?.split("=")[1],
};

// Logging utilities
const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  verbose: (msg) => CONFIG.verbose && console.log(`   ${msg}`),
};

// Execute git command
function exec(command) {
  try {
    log.verbose(`Executing: ${command}`);
    return execSync(command, { cwd: ROOT_DIR, encoding: "utf8" }).trim();
  } catch (error) {
    log.error(`Command failed: ${command}`);
    throw error;
  }
}

// Get all tags
function getTags() {
  try {
    const tags = exec("git tag --sort=-v:refname");
    return tags ? tags.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Get commits between two refs
function getCommits(from, to = "HEAD") {
  const format = "%H§%an§%ae§%ad§%s§%b";
  const mergeFlag = CONFIG.includeMerges ? "" : "--no-merges";
  const command = from
    ? `git log ${from}..${to} --pretty=format:"${format}" --date=iso ${mergeFlag}`
    : `git log ${to} --pretty=format:"${format}" --date=iso ${mergeFlag}`;

  const output = exec(command);
  if (!output) return [];

  return output
    .split("\n")
    .map((line) => {
      const parts = line.split("§");
      if (parts.length < 5) return null;

      const [hash, author, email, date, subject] = parts;
      const body = parts.slice(5).join("§").trim(); // Handle body with § characters

      return {
        hash: hash || "",
        author: author || "",
        email: email || "",
        date: date || "",
        subject: subject || "",
        body: body || "",
      };
    })
    .filter((commit) => commit && commit.hash && commit.subject); // Filter out empty commits
}

// Parse commit message
function parseCommit(commit) {
  const { hash, author, date, subject, body } = commit;

  // Safety checks for undefined values
  const safeSubject = subject || "";
  const safeBody = body || "";

  // Check for breaking changes
  const isBreaking =
    safeSubject.includes("!") ||
    safeBody.toLowerCase().includes("breaking change");

  // Parse conventional commit format
  const conventionalMatch = safeSubject.match(
    /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)/
  );

  if (conventionalMatch) {
    const [, type, scope, description] = conventionalMatch;
    return {
      hash: hash ? hash.substring(0, 7) : "unknown",
      type: type.toLowerCase(),
      scope,
      description,
      author: author || "Unknown",
      date: date ? new Date(date) : new Date(),
      breaking: isBreaking,
      body: safeBody,
    };
  }

  // Parse non-conventional commits
  return {
    hash: hash ? hash.substring(0, 7) : "unknown",
    type: "other",
    scope: null,
    description: safeSubject,
    author: author || "Unknown",
    date: date ? new Date(date) : new Date(),
    breaking: isBreaking,
    body: safeBody,
  };
}

// Group commits by type
function groupCommits(commits) {
  const groups = {
    breaking: [],
    features: [],
    fixes: [],
    performance: [],
    refactor: [],
    docs: [],
    tests: [],
    build: [],
    ci: [],
    chore: [],
    style: [],
    revert: [],
    deps: [],
    other: [],
  };

  commits.forEach((commit) => {
    const parsed = parseCommit(commit);

    if (parsed.breaking) {
      groups.breaking.push(parsed);
    }

    switch (parsed.type) {
      case "feat":
      case "feature":
        groups.features.push(parsed);
        break;
      case "fix":
      case "bugfix":
        groups.fixes.push(parsed);
        break;
      case "perf":
        groups.performance.push(parsed);
        break;
      case "refactor":
        groups.refactor.push(parsed);
        break;
      case "docs":
        groups.docs.push(parsed);
        break;
      case "test":
      case "tests":
        groups.tests.push(parsed);
        break;
      case "build":
        groups.build.push(parsed);
        break;
      case "ci":
        groups.ci.push(parsed);
        break;
      case "chore":
        groups.chore.push(parsed);
        break;
      case "style":
        groups.style.push(parsed);
        break;
      case "revert":
        groups.revert.push(parsed);
        break;
      case "deps":
      case "dep":
        groups.deps.push(parsed);
        break;
      default:
        groups.other.push(parsed);
    }
  });

  return groups;
}

// Format commit line
function formatCommit(commit) {
  const scope = commit.scope ? `**${commit.scope}:** ` : "";
  const repoUrl = getRepoUrl();
  const link = `([${commit.hash}](${repoUrl}/commit/${commit.hash}))`;

  return `- ${scope}${commit.description} ${link}`;
}

// Generate changelog section
function generateSection(version, date, groups) {
  const lines = [];

  // Version header
  if (version === "unreleased") {
    lines.push("## [Unreleased]");
  } else {
    lines.push(`## [${version}] - ${date}`);
  }
  lines.push("");

  // Breaking changes
  if (groups.breaking.length > 0) {
    lines.push("### ⚠️ BREAKING CHANGES");
    lines.push("");
    groups.breaking.forEach((commit) => {
      lines.push(formatCommit(commit));
      if (commit.body) {
        lines.push("");
        lines.push("  " + commit.body.trim().replace(/\n/g, "\n  "));
        lines.push("");
      }
    });
    lines.push("");
  }

  // Features
  if (groups.features.length > 0) {
    lines.push("### ✨ Features");
    lines.push("");
    groups.features.forEach((commit) => {
      lines.push(formatCommit(commit));
    });
    lines.push("");
  }

  // Bug fixes
  if (groups.fixes.length > 0) {
    lines.push("### 🐛 Bug Fixes");
    lines.push("");
    groups.fixes.forEach((commit) => {
      lines.push(formatCommit(commit));
    });
    lines.push("");
  }

  // Performance
  if (groups.performance.length > 0) {
    lines.push("### ⚡ Performance");
    lines.push("");
    groups.performance.forEach((commit) => {
      lines.push(formatCommit(commit));
    });
    lines.push("");
  }

  // Other sections (only if commits exist)
  const otherSections = [
    { key: "refactor", title: "♻️ Refactoring" },
    { key: "docs", title: "📝 Documentation" },
    { key: "tests", title: "✅ Tests" },
    { key: "build", title: "📦 Build" },
    { key: "ci", title: "👷 CI/CD" },
    { key: "deps", title: "📌 Dependencies" },
  ];

  otherSections.forEach(({ key, title }) => {
    if (groups[key].length > 0) {
      lines.push(`### ${title}`);
      lines.push("");
      groups[key].forEach((commit) => {
        lines.push(formatCommit(commit));
      });
      lines.push("");
    }
  });

  // Other commits (if not hiding)
  if (groups.other.length > 0 && !CONFIG.noOther) {
    lines.push("### 📝 Other Changes");
    lines.push("");
    groups.other.forEach((commit) => {
      lines.push(formatCommit(commit));
    });
    lines.push("");
  }

  return lines.join("\n");
}

// Generate full changelog
function generateChangelog() {
  const tags = getTags();
  const sections = [];

  // Header
  sections.push("# Changelog");
  sections.push("");
  sections.push(
    "All notable changes to this project will be documented in this file."
  );
  sections.push("");
  sections.push(
    "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),"
  );
  sections.push(
    "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)."
  );
  sections.push("");

  // Unreleased section
  if (CONFIG.unreleased || CONFIG.all) {
    const from = tags[0] || null;
    const commits = getCommits(from, "HEAD");

    if (commits.length > 0) {
      const groups = groupCommits(commits);
      sections.push(generateSection("unreleased", null, groups));
    }
  }

  // Released versions
  if (CONFIG.all || !CONFIG.unreleased) {
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      const previousTag = tags[i + 1] || null;

      // Get tag date
      const tagDate = exec(`git log -1 --format=%ai ${tag}`).split(" ")[0];

      // Get commits for this release
      const commits = getCommits(previousTag, tag);

      if (commits.length > 0) {
        const groups = groupCommits(commits);
        const version = tag.replace(/^v/, "");
        sections.push(generateSection(version, tagDate, groups));
      }
    }
  }

  // Add links section
  if ((CONFIG.all || !CONFIG.unreleased) && tags.length > 0) {
    sections.push("---");
    sections.push("");
    sections.push("## Links");
    sections.push("");

    const repoUrl = getRepoUrl();

    if (tags.length > 0) {
      sections.push(`[Unreleased]: ${repoUrl}/compare/${tags[0]}...HEAD`);

      for (let i = 0; i < tags.length - 1; i++) {
        const version = tags[i].replace(/^v/, "");
        sections.push(
          `[${version}]: ${repoUrl}/compare/${tags[i + 1]}...${tags[i]}`
        );
      }

      const firstVersion = tags[tags.length - 1].replace(/^v/, "");
      sections.push(
        `[${firstVersion}]: ${repoUrl}/releases/tag/${tags[tags.length - 1]}`
      );
    }
  }

  return sections.join("\n");
}

// Get repository URL
function getRepoUrl() {
  try {
    const remote = exec("git config --get remote.origin.url");

    // Convert SSH to HTTPS
    if (remote.startsWith("git@github.com:")) {
      return remote
        .replace("git@github.com:", "https://github.com/")
        .replace(".git", "");
    }

    // Clean HTTPS URL
    return remote.replace(".git", "");
  } catch {
    return "https://github.com/liquescent/log-correlator";
  }
}

// Suggest next version based on commits
function suggestVersion(commits) {
  const groups = groupCommits(commits);

  // Check for breaking changes
  if (groups.breaking.length > 0) {
    return "major";
  }

  // Check for features
  if (groups.features.length > 0) {
    return "minor";
  }

  // Check for fixes
  if (groups.fixes.length > 0 || groups.performance.length > 0) {
    return "patch";
  }

  // Only other changes
  return "patch";
}

// Get current version from package.json
function getCurrentVersion() {
  const possiblePaths = [
    path.join(ROOT_DIR, "packages/core/package.json"),
    path.join(ROOT_DIR, "package.json"),
  ];

  for (const packagePath of possiblePaths) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // Continue to next path
    }
  }

  return "0.0.0";
}

// Calculate next version
function getNextVersion(current, bump) {
  if (!current || !current.includes(".")) {
    current = "0.0.0";
  }

  const parts = current.split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  const patch = parseInt(parts[2] || "0", 10);

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      return current;
  }
}

// Main function
function main() {
  console.log("📝 Generating Changelog\n");

  try {
    // Generate content based on options
    let content;
    let commits = [];

    if (CONFIG.from) {
      // Generate for specific range
      log.info(`Generating changelog from ${CONFIG.from} to ${CONFIG.to}`);
      commits = getCommits(CONFIG.from, CONFIG.to);
      const groups = groupCommits(commits);
      content = generateSection(
        "Custom Range",
        new Date().toISOString().split("T")[0],
        groups
      );
    } else {
      // Generate full changelog
      log.info("Generating full changelog");
      content = generateChangelog();

      // Get unreleased commits for version suggestion
      const tags = getTags();
      const from = tags[0] || null;
      commits = getCommits(from, "HEAD");
    }

    // Show version suggestion for unreleased commits
    if (CONFIG.unreleased && commits.length > 0) {
      const currentVersion = getCurrentVersion();
      const suggestedBump = suggestVersion(commits);
      const nextVersion = getNextVersion(currentVersion, suggestedBump);

      log.info(`📦 Version Suggestion:`);
      log.info(`   Current: ${currentVersion}`);
      log.info(`   Suggested: ${nextVersion} (${suggestedBump} bump)`);
      log.info(`   Based on ${commits.length} commits since last release\n`);
    }

    // Write or display
    if (CONFIG.dryRun) {
      console.log("\n--- DRY RUN OUTPUT ---\n");
      console.log(content);
    } else {
      fs.writeFileSync(CONFIG.output, content);
      log.success(`Changelog written to ${CONFIG.output}`);
    }
  } catch (error) {
    log.error("Failed to generate changelog");
    console.error(error);
    process.exit(1);
  }
}

// CLI handling
if (require.main === module) {
  if (process.argv.includes("--help")) {
    console.log(`
📝 Changelog Generation Tool for log-correlator

Usage: node tools/changelog.js [options]

Options:
  --unreleased         Generate only unreleased changes
  --all                Generate complete changelog
  --from=<ref>         Generate from specific ref/tag
  --to=<ref>           Generate to specific ref/tag (default: HEAD)
  --output=<file>      Output file (default: CHANGELOG.md)
  --no-other           Hide commits without conventional type
  --include-merges     Include merge commits in output
  --dry-run            Show output without writing to file
  --verbose            Show detailed execution output
  --help               Show this help message

Examples:
  node tools/changelog.js --all                    # Generate complete changelog
  node tools/changelog.js --unreleased             # Generate only unreleased changes
  node tools/changelog.js --from=v1.0.0 --to=v2.0.0  # Generate for specific range
  node tools/changelog.js --dry-run --unreleased   # Preview unreleased changes
  node tools/changelog.js --no-other --all         # Hide non-conventional commits

Conventional Commit Types:
  feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

The tool follows Keep a Changelog format and supports Semantic Versioning.
    `);
    process.exit(0);
  }

  main();
}

module.exports = { generateChangelog, parseCommit, groupCommits };
