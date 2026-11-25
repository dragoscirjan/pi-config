import { checkRelease } from './release-check.mjs';

export function prepare(_config, context) {
  checkRelease(context.cwd);
}
