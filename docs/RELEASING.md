# Release maintenance

1. Update `package.json`, add a changelog entry and write `docs/releases/v<version>.md` in the same commit.
2. Merge to `main`. The normal CI runs the test suite.
3. After successful main CI, `release.yml` checks out that exact commit, verifies the notes and package version, creates a new tag and publishes source archives plus `SHA256SUMS`.
4. Verify the release assets and the linked CI run. Existing releases/tags are never overwritten by the workflow.

Versions containing a hyphen are prereleases and are explicitly excluded from stable `latest`. The README links the releases index and its badge includes prereleases. Source archives require the runtime and are not compiled binaries.

The release job uses repository `GITHUB_TOKEN`, without a personal token. No account session or cookie is required. A failed CI never publishes a release.
