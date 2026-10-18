import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import nodeImportPlugin from 'eslint-plugin-node-import';
import globals from 'globals';
import typescriptEslint from 'typescript-eslint';

const javascriptFiles = ['**/*.js', '**/*.mjs', '**/*.cjs'];
const typescriptFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

const sharedPlugins = {
  imports: importPlugin,
  'node-import': nodeImportPlugin,
};

const sharedRules = {
  'node-import/prefer-node-protocol': 'error',
  'imports/order': [
    'error',
    {
      groups: [['builtin'], ['external'], ['internal'], ['parent', 'sibling', 'index']],
      pathGroups: [
        {
          pattern: 'node:*',
          group: 'builtin',
          position: 'before',
        },
      ],
      pathGroupsExcludedImportTypes: ['builtin'],
      'newlines-between': 'ignore',
      alphabetize: {
        order: 'asc',
        caseInsensitive: true,
      },
    },
  ],
  'no-useless-escape': 'off',
};

const unusedVariableOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
};

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts', 'agent/extensions/**/out/**'],
  },
  {
    ...js.configs.recommended,
    name: 'pi-config/javascript',
    files: javascriptFiles,
    plugins: sharedPlugins,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...sharedRules,
      'no-unused-vars': ['error', unusedVariableOptions],
    },
  },
  ...typescriptEslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    name: 'pi-config/typescript',
    files: typescriptFiles,
    plugins: sharedPlugins,
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      ...sharedRules,
      'no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedVariableOptions],
    },
  },
];
