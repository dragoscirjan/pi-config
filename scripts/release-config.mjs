import { PACKAGE_NAME, REPOSITORY, WORKSPACE } from './release-check.mjs';

// Every successful main push releases; the highest matching rule wins.
export const commitRules = {
  preset: 'conventionalcommits',
  releaseRules: [{ breaking: true, release: 'major' }, { type: 'feat', release: 'minor' }, { release: 'patch' }],
};

export default {
  branches: ['main'],
  repositoryUrl: `https://github.com/${REPOSITORY}.git`,
  tagFormat: `${PACKAGE_NAME}@\${version}`,
  plugins: [
    ['@semantic-release/commit-analyzer', commitRules],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/npm', { pkgRoot: WORKSPACE, npmPublish: true }],
    // npm prepares the generated version first; audit that exact package before publication.
    './scripts/release-audit.mjs',
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
        addReleases: false,
      },
    ],
  ],
};
