# npm releases from this repository

This repository is a monorepo. No extension needs its own Git repository.

## Publication boundary

Only **`@dragoscirjan/pi-voice-ptt`**, from `agent/extensions/pi-voice-ptt`, is approved for npm publication. It uses the MIT license and independent versions. The repository root and the two other workspaces are private; Changesets also ignores those workspaces.

`npm run release:check` asks npm for its actual dry-run packlist, checks the package identity and provenance metadata, and permits only the entrypoint, runtime TypeScript, README, changelog, and license. It rejects tests, hidden files, personal config, dependencies, models, oversized artifacts, and missing relative imports. It never publishes.

The package reuses the existing voice/i18n workflow with machine-local model/device selection and an isolated whisper.cpp provider. Models, backend executables and preferences are never bundled. CI uses fake downloads/workers; physical GPU/microphone support is verified separately on each platform.

## One-time owner setup

Publishing is **disabled by default**. The release workflow skips all release work until the repository variable `NPM_PUBLISH_ENABLED` equals `true`. No npm credentials are committed or required for CI checks.

1. Confirm that you own the npm user/organization `@dragoscirjan` and have permission to publish public packages there.
2. Commit and push this setup. Review the Linux/macOS/Windows CI results. The CI matrix checks code and packaging, not microphone or GPU hardware.
3. Inspect the package locally:

   ```sh
   npm ci --ignore-scripts
   npm run release:verify
   ```

4. Bootstrap the first package publication from an authenticated workstation. **The following command actually publishes to npm; run it only after reviewing the dry-run result.** The initial version is `1.0.0`.

   ```sh
   npm login
   npm whoami
   npm publish --workspace @dragoscirjan/pi-voice-ptt --access public --registry https://registry.npmjs.org/ --provenance=false
   ```

   Complete npm's authentication/2FA prompts. This one-time manual bootstrap establishes the package so its trusted-publisher settings can be configured. It has no CI provenance attestation; subsequent CI releases do.

5. In the npm package's **Settings → Trusted Publisher**, configure GitHub Actions:

   | Field             | Value                                                      |
   | ----------------- | ---------------------------------------------------------- |
   | Organization/user | `dragoscirjan`                                             |
   | Repository        | `pi-config`                                                |
   | Workflow filename | `release.yml` — filename only                              |
   | Environment       | `npm`                                                      |
   | Allowed actions   | Direct `npm publish`; allow dist-tag management if offered |

6. In GitHub repository settings:
   - Create/configure the `npm` environment, restrict deployments to `main`, and optionally require a reviewer.
   - Under **Actions → General**, allow GitHub Actions to create pull requests.
   - Add the repository **Actions variable** `NPM_PUBLISH_ENABLED` with value `true` only after the trusted publisher is ready.

Do **not** add an `NPM_TOKEN`. GitHub supplies its normal `GITHUB_TOKEN`; npm publication uses short-lived OIDC credentials. The workflows pin Node 24 and npm 11.21.2. npm 11.21+ supports OIDC dist-tags; npm 12's changed registry JSON is deliberately excluded from publishing until the Changesets toolchain is upgraded and verified. It grants write/OIDC permissions only to the release job, after a separate read-only verification job passes. Publishing is restricted to this repository's `main` branch and can be disabled again by removing the variable or setting it to `false`.

## Normal release cycle

1. Make and test a change to the voice companion.
2. Run `npm run changeset`. Select `@dragoscirjan/pi-voice-ptt`, choose a patch/minor/major bump, and describe the user-facing change.
3. Commit the generated `.changeset/*.md` with the code and merge normally.
4. The release action opens/updates a **chore: release voice companion** PR. Changesets updates only this package's version/changelog; `release:version` updates the npm lockfile too. It explicitly dispatches the read-only CI workflow for that PR because GitHub does not automatically trigger other workflows from a `GITHUB_TOKEN`-created PR.
5. Review and merge the release PR. The next release run publishes the new version with provenance and creates its Git tag/GitHub release. Already-published versions are not republished.

Useful commands:

```sh
npm run release:status       # inspect pending changesets
npm run release:verify       # lint, format, tests, voice typecheck, dry-run artifact audit
npm run release:check        # inspect the real npm packlist; no publication
npm run release:version      # apply pending version/changelog changes locally; no publication
```

`npm run release:publish` is guarded and refuses to run outside the enabled GitHub Actions/OIDC environment. The only workstation publication path documented here is the deliberate, one-time direct `npm publish` bootstrap above.

Keep the Changesets CLI and action compatible: this setup uses the maintained CLI v2/action v1 combination, with GitHub Actions pinned to immutable commits. Review coordinated major upgrades rather than switching only one side.

## Install the published package

After the first publication:

```sh
pi install npm:@juicesharp/rpiv-i18n@2.15.0
pi install npm:@juicesharp/rpiv-voice@2.15.0
pi install npm:@dragoscirjan/pi-voice-ptt
```

The upstream packages must be installed **through Pi** so their own commands are enabled. They are optional peers in npm metadata to prevent npm from silently installing an unconfigured second copy; they are required to use dictation. Pi provides the host SDK/TUI peers itself.

Do not enable both the repository-local voice companion and its npm copy. For development, keep the local extension and omit the npm companion entry. For npm consumption on a machine with this checkout, use `pi config` to disable the local `agent/extensions/pi-voice-ptt/index.ts` resource before enabling the npm one. This task does not change your current Pi package settings.

## Add another publishable extension later

Prepare its scoped package identity, MIT/other chosen license, explicit package files, Pi manifest, and dependencies first. Then deliberately extend the release allowlist/tests, remove that workspace's `private` flag and Changesets ignore entry, and configure its own npm trusted publisher. Changesets can continue versioning packages independently from the same repository.
