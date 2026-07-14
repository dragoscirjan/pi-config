import defineConfig from '@templ-project/vitest';

export default defineConfig({
  include: ['*.test.ts'],
  environment: 'node',
  clearMocks: true,
  restoreMocks: true,
});
