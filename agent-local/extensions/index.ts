import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ExtensionHandler, type ToolCallEvent, type ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs/promises";
import Twig from "twig";
import os from "node:os";

export default async function (pi: ExtensionAPI) {
  // We perform this in the async factory so that the compilation completes
  // BEFORE Pi triggers `session_start` and `resources_discover`.
  // This guarantees that any generated SKILL.md files are ready for the 
  // system prompt build phase.

  // Note: ExtensionAPI in the factory doesn't have direct access to a Context object yet,
  // so we'll just use process.cwd() for local lookups.
  const cwd = process.cwd();

  await mockTwigSkills(cwd);

  pi.on('tool_call', realTimeTwigStillCompile);
}

const realTimeTwigStillCompile: ExtensionHandler<ToolCallEvent, ToolCallEventResult> = async (event: ToolCallEvent, ctx: ExtensionContext) => {
  if (isToolCallEventType('read', event) && event.input.path.endsWith('SKILL.md')) {
    const filePath = event.input.path;
    const twigPath = filePath + '.twig';

    try {
      // Check if the twig template exists
      await fs.access(twigPath);

      // Load twig configuration
      const twigConfig = await loadTwigConfig(ctx.cwd);

      // Collect context from session entries
      // We look for "custom" entries with customType "detected-language"
      const branchEntries = ctx.sessionManager.getBranch();
      let lastDetectedLanguage = "unknown";
      for (const entry of branchEntries) {
        if (entry.type === "custom" && entry.customType === "detected-language") {
          const data = entry.data as any;
          if (data?.language) {
            lastDetectedLanguage = data.language;
          }
        }
      }

      // Read and render the twig template
      const templateContent = await fs.readFile(twigPath, 'utf-8');
      
      // Create template and render (correct Twig API)
      const template = Twig.twig({
        data: templateContent
      });
      
      const renderedContent = template.render({
        ...twigConfig,
        cwd: ctx.cwd,
        homedir: os.homedir(),
        os: os.platform(),
        arch: os.arch(),
        context: {
          last_detected_language: lastDetectedLanguage
        }
      });

      ctx.ui.notify(`Rendered skill from ${twigPath}`);

      // Return the rendered content instead of letting the normal read proceed
      return {
        block: true,
        result: {
          content: [{ type: 'text', text: renderedContent }],
          details: { path: filePath }
        }
      };
    } catch (error) {
      ctx.ui.notify(`Failed to render ${twigPath}. Reverting to static version.`);
      // If anything fails, let the normal read operation proceed
      // This is intentional - we don't want to break normal operation
    }
  }
}

async function loadTwigConfig(cwd: string) {
  const home = os.homedir();
  const configPaths = [
    path.join(home, ".pi/pi-twig.json"),
    path.join(cwd, ".pi/pi-twig.json"),
    path.join(cwd, "pi-twig.json")
  ];

  let config = {};
  for (const p of configPaths) {
    try {
      const data = await fs.readFile(p, "utf8");
      config = { ...config, ...JSON.parse(data) };
    } catch (e) {
      // ignore missing or invalid config files
    }
  }
  return config;
}

/**
 * Creates placeholder SKILL.md files for all `.md.twig` templates found in known skill directories.
 * This ensures that Pi's built-in startup discovery logic will find the SKILL.md
 * files and inject their descriptions into the system prompt, while indicating
 * that the actual content will be generated at runtime.
 */
async function mockTwigSkills(cwd: string) {
  const home = os.homedir();

  // Potential locations for skills
  const searchPaths = [
    path.join(home, ".pi/agent/skills/**/*.md.twig"),
    path.join(home, ".agents/skills/**/*.md.twig"),
    path.join(cwd, "skills/**/*.md.twig"),
    path.join(cwd, ".pi/skills/**/*.md.twig"),
    path.join(cwd, ".agents/skills/**/*.md.twig")
  ];

  for (const pattern of searchPaths) {
    try {
      const files = await glob(pattern, { windowsPathsNoEscape: true });
      for (const file of files) {
        // The destination file simply drops the .twig extension
        const dest = file.replace(/\.twig$/, "");

        // Create a placeholder file with explanatory content
        // The name must match the parent directory name per Pi skills spec
        const placeholderContent = `---
name: ${path.basename(path.dirname(file))}
description: Dynamic coding guidelines or skill content based on runtime context.
---

# Dynamic Skill Placeholder

This skill is generated from a Twig template at runtime. 
Template file: ${file}
`;

        // Write the placeholder file so Pi's standard discovery can read it
        await fs.writeFile(dest, placeholderContent, "utf8");
      }
    } catch (e) {
      // It's safe to ignore permission errors on directories we don't own
      console.warn(`[pi-twig] Warning: Could not process pattern ${pattern}`, e);
    }
  }
}
