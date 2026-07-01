import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		// By default bash commands execute in ctx.cwd. If a command attempts to change dir or interact with other absolute paths:
		
		// Heuristic: check if the command references absolute paths outside of the allowed directories,
		// or paths that resolve outside (like ../../something). 
		// For a robust implementation, you would parse paths, but a simpler interceptor can check strings.

		const allowedPrefixes = [ctx.cwd, "/tmp"];
		const hasExplicitOutsidePaths = /\B(\/|[a-zA-Z]:\\|\.\.\/)[a-zA-Z0-9_\-\.\/]+/i.test(command);
		
		if (hasExplicitOutsidePaths) {
			// Do a very basic check to see if we clearly are referencing allowed prefixes
			const mentionsAllowed = allowedPrefixes.some(p => command.includes(p));
			
			// If it mentions absolute/parent paths and none of them are our allowed prefixes, flag it
			if (!mentionsAllowed) {
				if (!ctx.hasUI) {
					return { block: true, reason: "Command references paths outside the project or /tmp. Blocked (no UI for confirmation)." };
				}

				const choice = await ctx.ui.select(`⚠️ Command references paths outside project or /tmp:\n\n  ${command}\n\nAllow execution?`, ["No", "Yes"]);

				if (choice !== "Yes") {
					return { block: true, reason: "Command targeting unapproved directories blocked by user." };
				}
			}
		}

		return undefined;
	});
}