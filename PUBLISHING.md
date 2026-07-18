# Publishing a New Release

This project uses GitHub Actions to publish the VS Code extension to both the GitHub Releases page and the Visual Studio Marketplace. The workflow is defined in `.github/workflows/release.yml`.

## Prerequisites

- The Marketplace Personal Access Token (`VSCE_PAT`) must be configured as a repository secret in GitHub.
- You must be on the `main` branch with a clean working tree.

## Quick Reference

```bash
# 1. Update package.json version and CHANGELOG.md
# 2. Run verification
npm run compile
npm run lint
npm test
npx @vscode/vsce package --no-dependencies

# 3. Commit, tag, and push (this triggers the release workflow)
git add package.json package-lock.json CHANGELOG.md src/ ...
git commit -m "feat: describe the release"
git tag v1.5.1
git push origin main v1.5.1
```

## Detailed Steps

1. **Bump the version in `package.json`.**
   Use [Semantic Versioning](https://semver.org/):
   - `MAJOR` for incompatible API or behavior changes.
   - `MINOR` for new features (most common).
   - `PATCH` for bug fixes.

   Example: changing `1.5.0` → `1.5.1`.

2. **Update `CHANGELOG.md`.**
   Move the `## [Unreleased]` section into a new version section and add the release date.

3. **Sync `package-lock.json`.**
   Run:
   ```bash
   npm install --package-lock-only
   ```

4. **Run the full verification suite locally.**
   ```bash
   npm run compile
   npm run lint
   npm test
   npx @vscode/vsce package --no-dependencies
   ```

5. **Commit the changes.**
   ```bash
   git add package.json package-lock.json CHANGELOG.md src/ ...
   git commit -m "feat: describe the release"
   ```

6. **Create and push a version tag.**
   The tag must start with `v` to trigger the release workflow.
   ```bash
   git tag v1.5.1
   git push origin main v1.5.1
   ```

7. **Wait for GitHub Actions.**
   The `Release` workflow will:
   - compile and lint the code,
   - package the `.vsix`,
   - upload the `.vsix` to a GitHub Release with auto-generated notes,
   - publish the new version to the Visual Studio Marketplace.

   Monitor progress at:
   ```
   https://github.com/DimQ1/kimi-copilot-provider/actions/workflows/release.yml
   ```

## Troubleshooting

- If the release workflow fails at the Marketplace publish step, verify that `VSCE_PAT` is still valid and has the `Marketplace > Manage` scope.
- If the tag push fails because it already exists locally, delete it with `git tag -d v1.5.1` and recreate it after fixing the commit.
- Never push a `-alpha` or `-beta` tag unless the workflow is updated to handle pre-releases; the current `release.yml` publishes any `v*` tag to the Marketplace immediately.
