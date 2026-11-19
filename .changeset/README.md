# Extension releases

Only `@dragoscirjan/pi-voice-ptt` is publishable. The config root and other workspaces remain private.

For a voice feature or fix, run `npm run changeset`, choose the voice package and a patch/minor/major bump, then commit the generated Markdown file with the change. Versions and changelogs are maintained independently; packages stay in this repository.

See [RELEASING.md](../RELEASING.md) for dry-run checks, the one-time npm setup, and the gated GitHub Actions publishing workflow. Do not put credentials in a changeset or `.npmrc` committed to Git.
