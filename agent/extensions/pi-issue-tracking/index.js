import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
const TYPE_EMOTICONS = {
    initiative: "🚀",
    epic: "🏔️",
    story: "📖",
    task: "🛠️",
    bug: "🐛",
};
export default function (pi) {
    pi.registerTool({
        name: "issue_v2_create",
        label: "Create Issue",
        description: "Create a new issue file in .issues/ with auto-assigned 5-digit ID (V2-EXTENSION).",
        parameters: Type.Object({
            type: StringEnum(["initiative", "epic", "story", "task", "bug"]),
            title: Type.String(),
            description: Type.Optional(Type.String()),
            criteria: Type.Optional(Type.String()),
            status: Type.Optional(StringEnum(["open", "in_progress", "done", "closed"])),
            parent: Type.Optional(Type.String()),
            depends: Type.Optional(Type.String()),
            author: Type.Optional(Type.String()),
            assignee: Type.Optional(Type.String()),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const issuesDir = path.join(ctx.cwd, ".issues");
            if (!fs.existsSync(issuesDir))
                fs.mkdirSync(issuesDir, { recursive: true });
            const files = fs.readdirSync(issuesDir);
            let max = 0;
            for (const file of files) {
                const match = file.match(/^(\d+)/);
                if (match && match[1]) {
                    const val = parseInt(match[1], 10);
                    if (val > max)
                        max = val;
                }
            }
            const id = String(max + 1).padStart(5, "0");
            const type = String(params.type || "task");
            const title = String(params.title || "untitled");
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const filename = id + "-" + type + "-" + slug + ".md";
            const filepath = path.join(issuesDir, filename);
            let frontmatter = "---\n";
            frontmatter += "id: \"" + id + "\"\n";
            frontmatter += "type: " + type + "\n";
            frontmatter += "title: \"" + title + "\"\n";
            frontmatter += "status: " + (params.status || "open") + "\n";
            if (params.parent)
                frontmatter += "parent: \"" + params.parent + "\"\n";
            if (params.depends) {
                const deps = String(params.depends).split(",").map(d => "\"" + d.trim() + "\"").join(", ");
                frontmatter += "depends: [" + deps + "]\n";
            }
            if (params.author)
                frontmatter += "opencode-agent: " + params.author + "\n";
            if (params.assignee)
                frontmatter += "opencode-assignee: " + params.assignee + "\n";
            frontmatter += "---\n";
            const em = TYPE_EMOTICONS[type] || "";
            let body = "# " + em + " " + title + "\n\n";
            body += "## Description\n" + (params.description || "<!-- As a... I want to... So that... -->") + "\n\n";
            if (type === "bug") {
                body += "## Steps to Reproduce\n1. \n\n## Expected Behavior\n\n## Actual Behavior\n\n";
            }
            else if (["initiative", "epic", "story"].includes(type)) {
                body += "## Scope\n\n## Goals\n\n## Risks\n\n";
            }
            else if (type === "task") {
                body += "## Technical Requirements\n\n";
            }
            body += "## Acceptance Criteria\n" + (params.criteria || "- [ ] ") + "\n\n";
            body += "## Comments\n";
            fs.writeFileSync(filepath, frontmatter + "\n" + body, "utf-8");
            return { content: [{ type: "text", text: "Created: .issues/" + filename }], details: { id, filepath } };
        },
    });
    pi.registerTool({
        name: "issue_v2_list",
        label: "List Issues",
        description: "List issues from the local .issues/ directory.",
        parameters: Type.Object({
            status: Type.Optional(StringEnum(["open", "in_progress", "done", "closed"])),
            type: Type.Optional(StringEnum(["initiative", "epic", "story", "task", "bug"])),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const issuesDir = path.join(ctx.cwd, ".issues");
            if (!fs.existsSync(issuesDir))
                return { content: [{ type: "text", text: "No issues." }], details: { issues: [] } };
            const issues = [];
            const files = fs.readdirSync(issuesDir).filter(f => f.endsWith(".md"));
            for (const file of files) {
                const content = fs.readFileSync(path.join(issuesDir, file), "utf-8");
                const idMatch = content.match(/^id:\s*"?(\d+)"?/m);
                const stMatch = content.match(/^status:\s*"?([a-z_]+)"?/m);
                const tyMatch = content.match(/^type:\s*"?([a-z_]+)"?/m);
                const tiMatch = content.match(/^title:\s*"?(.+?)"?$/m);
                const id = idMatch && idMatch[1] ? idMatch[1] : "?????";
                const st = stMatch && stMatch[1] ? stMatch[1] : "unknown";
                const ty = tyMatch && tyMatch[1] ? tyMatch[1] : "unknown";
                const ti = tiMatch && tiMatch[1] ? tiMatch[1] : "untitled";
                if (params.status && params.status !== st)
                    continue;
                if (params.type && params.type !== ty)
                    continue;
                const em = TYPE_EMOTICONS[ty] || " ";
                issues.push("[" + id + "] " + em + " " + String(ty || "unknown").padEnd(10) + " | " + String(st || "unknown").padEnd(12) + " | " + ti);
            }
            return { content: [{ type: "text", text: issues.sort().join("\n") || "None found." }], details: { issues } };
        },
    });
    pi.registerTool({
        name: "issue_v2_read",
        label: "Read Issue",
        description: "Read the full content of a specific issue.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const issuesDir = path.join(ctx.cwd, ".issues");
            const sid = String(params.id || "").trim();
            if (!sid)
                throw new Error("ID required.");
            const files = fs.readdirSync(issuesDir).filter(f => f.endsWith(".md") && f.startsWith(sid + "-"));
            if (files.length !== 1)
                throw new Error("Not found.");
            const fn = files[0];
            return { content: [{ type: "text", text: fs.readFileSync(path.join(issuesDir, fn), "utf-8") }], details: { file: fn } };
        },
    });
    pi.registerTool({
        name: "issue_v2_comment",
        label: "Add Comment",
        description: "Add a structured update/comment to an issue.",
        parameters: Type.Object({
            id: Type.String(),
            update: Type.String(),
            artifacts: Type.Optional(Type.String()),
            next_steps: Type.Optional(Type.String()),
            blockers: Type.Optional(Type.String()),
            author: Type.Optional(Type.String()),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const issuesDir = path.join(ctx.cwd, ".issues");
            const cid = String(params.id || "").trim();
            if (!cid)
                throw new Error("ID required.");
            const files = fs.readdirSync(issuesDir).filter(f => f.endsWith(".md") && f.startsWith(cid + "-"));
            if (files.length !== 1)
                throw new Error("Not found.");
            const fn = files[0];
            const filePath = path.join(issuesDir, fn);
            let fc = fs.readFileSync(filePath, "utf-8");
            let comment = "\n### Update: " + new Date().toISOString().split("T")[0] + "\n\n";
            comment += "**Status Update:**\n" + (params.update || "") + "\n\n";
            if (params.artifacts)
                comment += "**Artifacts:**\n" + params.artifacts + "\n\n";
            if (params.next_steps || params.blockers) {
                comment += "**Next Steps / Blockers:**\n";
                if (params.next_steps)
                    comment += "- Next: " + params.next_steps + "\n";
                if (params.blockers)
                    comment += "- Blocked by: " + params.blockers + "\n";
                comment += "\n";
            }
            comment += "opencode-agent: " + (params.author || "agent") + "\n";
            fs.writeFileSync(filePath, fc + "\n---\n" + comment, "utf-8");
            return { content: [{ type: "text", text: "Comment added to " + fn }], details: { file: fn } };
        },
    });
}
//# sourceMappingURL=index.js.map