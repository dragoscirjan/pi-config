import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import commandModelRecommend from "./command-model-recommend";
import { registerActiveModelsCommand } from "./command-active-models";

export default function (pi: ExtensionAPI) {
	// Full original /model-recommend functionality (migrated from @agent/model-recommend.ts)
	commandModelRecommend(pi);

	// Keep the separate /active-models command from the new module
	registerActiveModelsCommand(pi);
}
