# Publishing Guide

## Automated Publishing (Recommended)

Packages are automatically published to npm when a version tag is pushed to GitHub.

### Quick Release Process

```bash
# 1. Bump version (patch, minor, or major)
node scripts/bump-version.js patch  # 0.0.6 -> 0.0.7

# 2. Commit changes
git add -A
git commit -m "chore: bump version to 0.0.7"

# 3. Create and push tag
git tag v0.0.7
git push && git push --tags

# 4. GitHub Actions will automatically publish to npm!
```

## Prerequisites for Automated Publishing

1. **NPM_TOKEN** secret must be set in GitHub repository settings
   - Get token from npm: `npm token create`
   - Add to GitHub: Settings → Secrets → Actions → New repository secret
   - Name: `NPM_TOKEN`
   - Value: Your npm token

2. npm account with access to `@liquescent` scope

## Version Management

This project uses semantic versioning:

- `0.0.x` - Initial development, unstable API
- `0.x.x` - Pre-release, breaking changes expected
- `1.0.0` - First stable release with public API commitment

Current version: `0.0.6` (initial development)

## Publishing Options

### Option 1: npm Public Registry (Recommended for Open Source)

```bash
# First time setup - make packages public
npm config set @liquescent:registry https://registry.npmjs.org/
npm config set access public

# Build all packages
npm run build

# Publish all packages
npm run publish:all
```

### Option 2: GitHub Packages

1. Create a `.npmrc` file in the project root:

```
@liquescent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

2. Set your GitHub token:

```bash
export GITHUB_TOKEN=your_github_personal_access_token
```

3. Publish:

```bash
npm run build
npm run publish:all
```

### Option 3: Private Registry

Configure your private registry in `.npmrc`:

```
@liquescent:registry=https://your-registry.com
//your-registry.com/:_authToken=${AUTH_TOKEN}
```

## Publishing Workflow

### First Time Publishing

1. **Decide on registry** (npm, GitHub Packages, or private)
2. **Configure authentication** as shown above
3. **Build all packages**:
   ```bash
   npm run build
   ```
4. **Publish in dependency order**:
   ```bash
   # Must publish in this order due to dependencies
   npm publish packages/query-parser --access public
   npm publish packages/core --access public
   npm publish packages/adapters/loki --access public
   npm publish packages/adapters/graylog --access public
   npm publish packages/adapters/promql --access public
   ```

### Subsequent Releases

1. **Update versions** using the release tool:

   ```bash
   node tools/release.js patch  # for 0.0.6 -> 0.0.7
   node tools/release.js minor  # for 0.0.6 -> 0.1.0
   node tools/release.js major  # for 0.x.x -> 1.0.0
   ```

2. **Build and test**:

   ```bash
   npm run build
   npm test
   ```

3. **Publish updated packages**:
   ```bash
   npm run publish:all
   ```

## Automating Publication

The repository includes a GitHub Action for automated releases:

- Trigger manually via GitHub Actions UI
- Or push a tag: `git tag v0.0.7 && git push --tags`

## Testing Installation

After publishing, test that packages can be installed:

```bash
# In a new test directory
mkdir test-install && cd test-install
npm init -y

# Test installation
npm install @liquescent/log-correlator-core@0.0.6
npm install @liquescent/log-correlator-loki@0.0.6
npm install @liquescent/log-correlator-graylog@0.0.6

# Test usage
node -e "const { CorrelationEngine } = require('@liquescent/log-correlator-core'); console.log('Success!')"
```

## Troubleshooting

### "402 Payment Required" Error

- npm requires payment for private scoped packages
- Either make packages public with `--access public` or use GitHub Packages

### "E403 Forbidden" Error

- Not authenticated or lacking permissions
- Run `npm login` and ensure you have access to the scope

### "E404 Not Found" Error for Dependencies

- Dependencies not yet published
- Ensure you publish packages in the correct order (query-parser first, then core, then adapters)

## Package Visibility

For open source (AGPLv3 licensed):

- Use `--access public` when publishing to npm
- Packages will be freely available to everyone

For private/commercial use:

- Use GitHub Packages or private npm registry
- Configure authentication as described above
