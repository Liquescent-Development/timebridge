# Release Checklist

## Before Release

- [ ] All tests passing locally (`npm test`)
- [ ] Linter passing (`npm run lint`)
- [ ] Type checking passing (`npm run typecheck`)
- [ ] Documentation updated if needed
- [ ] CHANGELOG.md updated (or will be auto-generated)
- [ ] All PRs for this release merged to main
- [ ] Pull latest main branch locally

## Release Process

### Option 1: Quick Release (Recommended)

```bash
# For patch release (0.0.6 -> 0.0.7)
npm run release:patch
git push && git push --tags

# For minor release (0.0.6 -> 0.1.0)
npm run release:minor
git push && git push --tags

# For major release (0.1.0 -> 1.0.0)
npm run release:major
git push && git push --tags
```

### Option 2: Manual Release

```bash
# 1. Bump version
node scripts/bump-version.js patch

# 2. Review changes
git diff

# 3. Commit
git add -A
git commit -m "chore: bump version to 0.0.7"

# 4. Tag
git tag v0.0.7

# 5. Push
git push && git push --tags
```

## After Release

- [ ] Check GitHub Actions - "Publish to npm" workflow should be running
- [ ] Verify packages published to npm:
  - https://www.npmjs.com/package/@liquescent/log-correlator-core
  - https://www.npmjs.com/package/@liquescent/log-correlator-loki
  - https://www.npmjs.com/package/@liquescent/log-correlator-graylog
  - https://www.npmjs.com/package/@liquescent/log-correlator-promql
  - https://www.npmjs.com/package/@liquescent/log-correlator-query-parser
- [ ] GitHub Release created automatically with changelog
- [ ] Test installation in a fresh project:
  ```bash
  mkdir test-install && cd test-install
  npm init -y
  npm install @liquescent/log-correlator-core@latest
  ```
- [ ] Announce release (if applicable)

## Troubleshooting

### GitHub Action Failed

1. Check the Actions tab in GitHub
2. Look for "Publish to npm" workflow
3. Click on the failed run to see logs
4. Common issues:
   - Missing NPM_TOKEN secret
   - Version mismatch between packages
   - Test failures
   - Network issues

### Manual Publishing (Emergency Only)

If GitHub Actions is down, you can publish manually:

```bash
# Ensure you're on the tagged commit
git checkout v0.0.7

# Login to npm
npm login

# Build and test
npm run build
npm test

# Publish
npm run publish:all
```

## Version Guidelines

- **Patch (0.0.x)**: Bug fixes, documentation updates
- **Minor (0.x.0)**: New features, backwards compatible
- **Major (x.0.0)**: Breaking changes

While in 0.x.x:

- API is considered unstable
- Breaking changes can happen in minor versions
- Use 0.0.x for initial development
- Use 0.1.0 for first "usable" version
- Use 1.0.0 for stable API commitment
