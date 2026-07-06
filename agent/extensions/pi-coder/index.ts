import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".js": "javascript",
  ".ts": "typescript",
  ".jsx": "jsx",
  ".tsx": "tsx",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".json": "json",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".py": "python",
  ".java": "java",
  ".cpp": "cpp",
  ".c": "c",
  ".cs": "csharp",
  ".go": "go",
  ".rs": "rust",
  ".php": "php",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".pl": "perl",
  ".r": "r",
  ".sh": "shell",
  ".bash": "bash",
  ".ps1": "powershell",
  ".md": "markdown",
  ".markdown": "markdown",
  ".sql": "sql",
  ".graphql": "graphql",
  ".proto": "protobuf",
  ".dart": "dart",
  ".lua": "lua",
  ".groovy": "groovy",
  ".hs": "haskell",
  ".elm": "elm",
  ".clj": "clojure",
  ".erl": "erlang",
  ".ex": "elixir",
  ".fs": "fsharp",
  ".ml": "ocaml",
  ".zig": "zig",
  ".nim": "nim"
};

const DetectLanguageParams = Type.Object({
  path: Type.String({ description: "File path to detect language for" })
});

interface DetectLanguageDetails {
  language: string;
  path: string;
}

export default function piCoderExtension(pi: ExtensionAPI) {
  /**
   * Reconstruct state from session entries.
   * This ensures the last detected language is available across session reloads.
   */
  const reconstructState = (ctx: ExtensionContext) => {
    // Scan for the last detected-language entry in the current branch
    const branchEntries = ctx.sessionManager.getBranch();
    let lastDetectedLanguage = "unknown";
    let lastDetectedPath = "";
    
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "detected-language") {
        const data = entry.data as any;
        if (data?.language) {
          lastDetectedLanguage = data.language;
          lastDetectedPath = data.path || "";
        }
      }
    }
    
    return { language: lastDetectedLanguage, path: lastDetectedPath };
  };

  // Register the detect_language tool for the LLM
  pi.registerTool({
    name: "detect_language",
    label: "Language Detector",
    description: "Detect programming language based on file extension and update session context for dynamic skill loading.",
    parameters: DetectLanguageParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: DetectLanguageDetails;
    }> {
      const ext = "." + params.path.split(".").pop()?.toLowerCase();
      const language = LANGUAGE_EXTENSIONS[ext] || "unknown";

      // Store in session as a custom entry so pi-twig can access it
      pi.appendEntry("custom", {
        customType: "detected-language",
        data: {
          language: language,
          path: params.path
        }
      });

      return {
        content: [
          {
            type: "text",
            text: `Detected language: ${language} for file ${params.path}. Session context updated. You can now read the 'coding' skill to get language-specific guidelines.`
          }
        ],
        details: {
          language: language,
          path: params.path
        }
      };
    }
  });

  // Reconstruct state on session events
  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
}
