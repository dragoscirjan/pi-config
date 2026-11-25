# Automatic npm releases

Only **`@dragoscirjan/pi-voice-ptt`**, from `agent/extensions/pi-voice-ptt`, is approved for public npm publication. The repository root and other workspaces stay private. Models, backend executables, machine preferences, tests, and personal configuration are never bundled.

## Push-to-release flow

1. Push or merge changes to `main` in `dragoscirjan/pi-config`.
2. The existing **CI** workflow runs lint, formatting, all tests, voice typechecking, and the npm artifact audit on **Linux, macOS, and Windows**.
3. Only after that entire workflow succeeds, **Release** checks out its exact tested SHA and runs semantic-release. Failed, cancelled, skipped, fork, PR, and manually dispatched CI runs cannot publish.
4. semantic-release calculates the next version from commits since the previous package tag, updates the voice package's version in the release checkout, audits the prepared package again, publishes it to npm, and creates a Git tag and GitHub release with generated notes.

There is no separate version PR, manual version bump, or `NPM_PUBLISH_ENABLED` variable. The first release is **`1.0.0`**. Subsequent releases use the highest applicable bump in the push:

| Commit message                              | Version bump |
| ------------------------------------------- | ------------ |
| `feat!: ...` or a `BREAKING CHANGE:` footer | Major        |
| `feat: ...`                                 | Minor        |
| `fix: ...`, docs, chores, or other commits  | Patch        |

Every new successful `main` push is eligible for a release, including documentation/tooling changes. A retry with no commits since the last release does not create another version. Keep Conventional Commit messages when squash-merging; for merge commits, the underlying commits are also analyzed.

Tags have the form `@dragoscirjan/pi-voice-ptt@1.2.3`. Tags and published npm metadata are the authoritative release versions. The committed package/lockfile keep the development baseline: generated versions are **not** committed back to `main`, so publishing cannot trigger a release loop or require a branch-protection bypass. Generated release notes live in GitHub releases; the checked-in changelog retains the initial package history.

Release jobs are serialized and do not cancel an active publication. CI may cancel superseded checks. semantic-release also checks the remote branch before releasing; if the tested SHA has fallen behind `main`, it skips it and waits for the newer push's successful CI. Never replace the tested checkout with the latest untested branch head.

## One-time npm owner setup

The first package does not exist on npm yet, so its trusted publisher cannot be configured in advance. Bootstrap **through the same CI workflow**, not a manual workstation publication:

1. Confirm ownership of the npm scope `@dragoscirjan` and permission to create public packages.
2. Create a short-lived npm granular access token with read/write permission to create/publish this package and permission to bypass 2FA for noninteractive publishing. Its package/scope selection must permit the **new** package, not just existing packages. Use the narrowest permissions npm offers for this bootstrap.
3. Add it as the GitHub Actions secret **`NPM_TOKEN`** in `dragoscirjan/pi-config` (repository secret or secret in the `npm` environment). Do not put it in a file, commit, PR, or chat. GitHub supplies `GITHUB_TOKEN` automatically.
4. Configure the GitHub environment **`npm`**, restricting deployment branches to `main`. GitHub can create it when first referenced; configure branch restrictions before merging this workflow. A required reviewer adds a manual approval, so omit reviewers for fully automatic releases.
5. Merge this setup to `main`. Once all three CI platforms pass, Release publishes `1.0.0` automatically using the token. If an earlier attempt failed authentication, add/fix the secret and rerun its failed Release job while that tested SHA is still current.
6. In the npm package's **Settings → Trusted Publisher**, configure:

   | Field             | Value                                          |
   | ----------------- | ---------------------------------------------- |
   | Organization/user | `dragoscirjan`                                 |
   | Repository        | `pi-config`                                    |
   | Workflow filename | `release.yml`                                  |
   | Environment       | `npm`                                          |
   | Allowed actions   | Publishing and dist-tag management, if offered |

7. Delete the `NPM_TOKEN` GitHub secret and revoke the bootstrap token. Future releases use short-lived GitHub OIDC credentials, with provenance attestations. Do not remove the secret until trusted publishing is configured.

No permission for Actions to create PRs is needed. Only the release job has `contents: write` and `id-token: write`; CI stays read-only. Checkout does not persist a GitHub credential. npm authentication is exposed only to the publish step.

If npm authentication is missing or misconfigured, Release **fails visibly** rather than silently skipping. A PR cannot create an npm token or configure npm trusted publishing on behalf of the scope owner. Both workflows pin Node 24 and npm 11.21.2; the lockfile pins the Node-24-compatible semantic-release 25 toolchain and plugins.

## Local checks and maintenance

```sh
npm ci --ignore-scripts
npm run release:verify  # full verification; never publishes
npm run test:release    # artifact/auth/workflow/SemVer regression tests
npm run release:check   # real npm dry-run packlist and import audit
```

The release tests exercise initial/patch/minor/major versions and actual tag creation against a temporary **local** Git remote. Their npm plugin has publication disabled; they never publish to npm or GitHub. Physical microphone/GPU behavior still needs platform-specific manual verification.

`npm run release:publish` refuses workstation invocation, non-main refs, failed/untrusted CI events, and any checkout that differs from the successful CI SHA. It is not a local release command.

`npm run release:check` validates the publication boundary, actual packlist, size, metadata, and relative imports. A second audit runs after semantic-release prepares the generated version and before npm publication. Keep that audit immediately after the npm plugin in `scripts/release-config.mjs` when changing release tooling.

## Install the published package

After the first publication:

```sh
pi install npm:@juicesharp/rpiv-i18n@2.15.0
pi install npm:@juicesharp/rpiv-voice@2.15.0
pi install npm:@dragoscirjan/pi-voice-ptt
```

The upstream packages must be installed **through Pi** so their own commands are enabled. They are optional peers in npm metadata to prevent npm from silently installing an unconfigured second copy; they are required to use dictation. Pi provides the host SDK/TUI peers itself. See the extension README for model/device/backend setup.

Do not enable both the repository-local voice companion and its npm copy. For development, keep the local extension and omit the npm companion entry. For npm consumption on a machine with this checkout, use `pi config` to disable the local `agent/extensions/pi-voice-ptt/index.ts` resource before enabling the npm one. This change does not modify your current Pi package settings.
