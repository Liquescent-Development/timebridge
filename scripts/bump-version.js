#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * Version bump script for monorepo
 * Updates all package versions and inter-package dependencies
 *
 * Usage:
 *   node scripts/bump-version.js patch  # 0.0.1 -> 0.0.2
 *   node scripts/bump-version.js minor  # 0.0.1 -> 0.1.0
 *   node scripts/bump-version.js major  # 0.0.1 -> 1.0.0
 *   node scripts/bump-version.js 0.2.5  # Set specific version
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PACKAGES = [
  "packages/query-parser",
  "packages/core",
  "packages/adapters/loki",
  "packages/adapters/graylog",
  "packages/adapters/promql",
  "packages/examples",
];

// Internal package dependencies - kept for future use
// const INTERNAL_DEPS = [
//   '@liquescent/log-correlator-core',
//   '@liquescent/log-correlator-query-parser',
//   '@liquescent/log-correlator-loki',
//   '@liquescent/log-correlator-graylog',
//   '@liquescent/log-correlator-promql'
// ];

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync("packages/core/package.json", "utf8"));
  return pkg.version;
}

function incrementVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);

  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      // Assume it's a specific version
      if (!/^\d+\.\d+\.\d+$/.test(type)) {
        throw new Error(`Invalid version or increment type: ${type}`);
      }
      return type;
  }
}

function updatePackageVersion(pkgPath, newVersion) {
  const pkgFile = path.join(pkgPath, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));

  const oldVersion = pkg.version;
  pkg.version = newVersion;

  // Keep file: references for local development
  // The publish workflow will replace these with proper versions

  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`✅ ${pkg.name}: ${oldVersion} → ${newVersion}`);
}

function updateReadmeVersions(oldVersion, newVersion) {
  const readmeFiles = [
    "README.md",
    "packages/adapters/loki/README.md",
    "packages/adapters/graylog/README.md",
    "packages/adapters/promql/README.md",
    "packages/core/README.md",
    "packages/query-parser/README.md",
    "packages/examples/README.md",
  ];

  for (const readmePath of readmeFiles) {
    let content;
    let originalContent;

    try {
      content = fs.readFileSync(readmePath, "utf8");
      originalContent = content;
    } catch (error) {
      // File doesn't exist or can't be read, skip it
      continue;
    }

    // Update version in npm install commands
    // Match patterns like: @liquescent/log-correlator-core@^0.0.1
    content = content.replace(
      /(@liquescent\/log-correlator-[a-z-]+@\^?)\d+\.\d+\.\d+/g,
      `$1${newVersion}`
    );

    // Update version in the pre-release warning
    // Match pattern like: This is version 0.0.1
    content = content.replace(
      /This is version \d+\.\d+\.\d+/g,
      `This is version ${newVersion}`
    );

    // Update any standalone version references in code blocks
    // Match patterns like: "version": "0.0.1"
    content = content.replace(
      /"version":\s*"\d+\.\d+\.\d+"/g,
      `"version": "${newVersion}"`
    );

    if (content !== originalContent) {
      fs.writeFileSync(readmePath, content);
      console.log(`📝 Updated versions in ${readmePath}`);
    }
  }
}

function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error(
      "Usage: node scripts/bump-version.js [patch|minor|major|x.y.z]"
    );
    process.exit(1);
  }

  const currentVersion = getCurrentVersion();
  const newVersion = incrementVersion(currentVersion, arg);

  console.log(`\n📦 Bumping version from ${currentVersion} to ${newVersion}\n`);

  // Update all packages
  for (const pkgPath of PACKAGES) {
    updatePackageVersion(pkgPath, newVersion);
  }

  // Update versions in README files
  console.log("\n📚 Updating README versions...");
  updateReadmeVersions(currentVersion, newVersion);

  // Update lock file
  console.log("\n🔄 Updating package-lock.json...");
  execSync("npm install", { stdio: "inherit" });

  console.log("\n✨ Version bump complete!");
  console.log("\nNext steps:");
  console.log("1. Review the changes: git diff");
  console.log(
    '2. Commit the changes: git add -A && git commit -m "chore: bump version to ' +
      newVersion +
      '"'
  );
  console.log("3. Create a tag: git tag v" + newVersion);
  console.log("4. Push changes and tag: git push && git push --tags");
  console.log(
    "\nThe GitHub Action will automatically publish to npm when the tag is pushed."
  );
}

try {
  main();
} catch (error) {
  console.error("❌ Error:", error.message);
  process.exit(1);
}
