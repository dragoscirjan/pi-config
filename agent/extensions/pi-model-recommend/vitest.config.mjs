import tempelVitestConfig from '@tempel/vitest';

export default tempelVitestConfig({
  include: ['*.test.ts'],
  environment: 'node',
  clearMocks: true,
  restoreMocks: true,
});
