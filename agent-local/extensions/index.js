import { glob } from "glob";
import path from "node:path";
import fs from "node:fs/promises";
import Twig from "twig";
import os from "node:os";
async function loadTwigConfig(cwd) {
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
        }
        catch (e) {
            // ignore missing or invalid config files
        }
    }
    return config;
}
/**
 * Compiles all `.md.twig` files found in known skill directories into `.md` files.
 * This ensures that Pi's built-in startup discovery logic will find the SKILL.md
 * files and inject their descriptions into the system prompt.
 */
async function compileTwigSkills(cwd) {
    const home = os.homedir();
    const config = await loadTwigConfig(cwd);
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
                // Render the twig template
                // We inject some useful context variables that the template might use.
                const content = await new Promise((resolve, reject) => {
                    Twig.renderFile(file, {
                        ...config,
                        os: os.platform(),
                        arch: os.arch(),
                        cwd: cwd,
                        homedir: home,
                        allowInlineIncludes: true
                    }, (err, html) => {
                        if (err)
                            reject(err);
                        else
                            resolve(html);
                    });
                });
                // Write the compiled file so Pi's standard discovery can read it
                await fs.writeFile(dest, content, "utf8");
            }
        }
        catch (e) {
            // It's safe to ignore permission errors on directories we don't own
            console.warn(`[pi-twig] Warning: Could not compile pattern ${pattern}`, e);
        }
    }
}
export default async function (pi) {
    // We perform this in the async factory so that the compilation completes
    // BEFORE Pi triggers `session_start` and `resources_discover`.
    // This guarantees that any generated SKILL.md files are ready for the 
    // system prompt build phase.
    // Note: ExtensionAPI in the factory doesn't have direct access to a Context object yet,
    // so we'll just use process.cwd() for local lookups.
    const cwd = process.cwd();
    await compileTwigSkills(cwd);
    // Optionally, you can also intercept the "read" tool if you want to allow the LLM 
    // to dynamically read raw .twig files and see the compiled output instead.
}
//# sourceMappingURL=index.js.map