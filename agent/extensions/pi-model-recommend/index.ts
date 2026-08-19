import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerActiveModelsCommand } from './command-active-models';
import commandModelRecommend from './command-model-recommend';

export default function (pi: ExtensionAPI) {
  // Full original /model-recommend functionality (migrated from @agent/model-recommend.ts)
  commandModelRecommend(pi);

  // Keep the separate /active-models command from the new module
  registerActiveModelsCommand(pi);
}
