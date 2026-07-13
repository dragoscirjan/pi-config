import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

type IssueType = 'initiative' | 'epic' | 'story' | 'task' | 'bug';
type IssueStatus = 'open' | 'in_progress' | 'done' | 'closed';

const TYPE_EMOTICONS: Record<IssueType, string> = {
  initiative: '🚀',
  epic: '🏔️',
  story: '📖',
  task: '🛠️',
  bug: '🐛',
};

function ensureIssuesDir(cwd: string): string {
  const issuesDir = path.join(cwd, '.issues');
  if (!fs.existsSync(issuesDir)) fs.mkdirSync(issuesDir, { recursive: true });
  return issuesDir;
}

function yamlQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sanitizeSingleLine(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n]+/g, ' ').trim();
  return cleaned || fallback;
}

function parseDepends(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((dep) => dep.trim())
    .filter(Boolean);
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return {};

  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    out[key] = stripYamlQuotes(value);
  }
  return out;
}

function nextIssueId(issuesDir: string): string {
  const files = fs.readdirSync(issuesDir);
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match || !match[1]) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return String(max + 1).padStart(5, '0');
}

function createIssueAtomically(
  issuesDir: string,
  type: IssueType,
  title: string,
  status: IssueStatus,
  description: string,
  criteria: string,
  parent: string,
  depends: string[],
  author: string,
  assignee: string,
): { id: string; filename: string; filepath: string } {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'untitled';

  for (let attempt = 0; attempt < 128; attempt++) {
    const id = nextIssueId(issuesDir);
    const filename = `${id}-${type}-${slug}.md`;
    const filepath = path.join(issuesDir, filename);

    let fd: number | undefined;
    try {
      fd = fs.openSync(filepath, 'wx');

      let frontmatter = '---\n';
      frontmatter += `id: ${yamlQuoted(id)}\n`;
      frontmatter += `type: ${type}\n`;
      frontmatter += `title: ${yamlQuoted(title)}\n`;
      frontmatter += `status: ${status}\n`;
      if (parent) frontmatter += `parent: ${yamlQuoted(parent)}\n`;
      if (depends.length > 0) {
        const serialized = depends.map((dep) => yamlQuoted(dep)).join(', ');
        frontmatter += `depends: [${serialized}]\n`;
      }
      if (author) frontmatter += `opencode-agent: ${yamlQuoted(author)}\n`;
      if (assignee) frontmatter += `opencode-assignee: ${yamlQuoted(assignee)}\n`;
      frontmatter += '---\n';

      const em = TYPE_EMOTICONS[type] ?? '';
      let body = `# ${em} ${title}\n\n`;
      body += `## Description\n${description || '<!-- As a... I want to... So that... -->'}\n\n`;
      if (type === 'bug') {
        body += '## Steps to Reproduce\n1. \n\n## Expected Behavior\n\n## Actual Behavior\n\n';
      } else if (type === 'initiative' || type === 'epic' || type === 'story') {
        body += '## Scope\n\n## Goals\n\n## Risks\n\n';
      } else {
        body += '## Technical Requirements\n\n';
      }
      body += `## Acceptance Criteria\n${criteria || '- [ ] '}\n\n`;
      body += '## Comments\n';

      fs.writeFileSync(fd, `${frontmatter}\n${body}`, 'utf-8');
      fs.closeSync(fd);
      return { id, filename, filepath };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // noop
        }
      }
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : '';
      if (code === 'EEXIST') continue;
      throw error;
    }
  }

  throw new Error('Failed to allocate issue ID after multiple attempts.');
}

export default function registerIssueTrackingExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'issue_create',
    label: 'Create Issue',
    description: 'Create a new issue file in .issues/ with auto-assigned 5-digit ID (V2-EXTENSION).',
    parameters: Type.Object({
      type: StringEnum(['initiative', 'epic', 'story', 'task', 'bug']),
      title: Type.String(),
      description: Type.Optional(Type.String()),
      criteria: Type.Optional(Type.String()),
      status: Type.Optional(StringEnum(['open', 'in_progress', 'done', 'closed'])),
      parent: Type.Optional(Type.String()),
      depends: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issuesDir = ensureIssuesDir(ctx.cwd);
      const type = (sanitizeSingleLine(params.type, 'task') as IssueType) ?? 'task';
      const title = sanitizeSingleLine(params.title, 'untitled');
      const status = (sanitizeSingleLine(params.status, 'open') as IssueStatus) ?? 'open';
      const description = typeof params.description === 'string' ? params.description : '';
      const criteria = typeof params.criteria === 'string' ? params.criteria : '';
      const parent = sanitizeSingleLine(params.parent);
      const depends = parseDepends(params.depends);
      const author = sanitizeSingleLine(params.author);
      const assignee = sanitizeSingleLine(params.assignee);

      const created = createIssueAtomically(
        issuesDir,
        type,
        title,
        status,
        description,
        criteria,
        parent,
        depends,
        author,
        assignee,
      );

      return {
        content: [{ type: 'text', text: `Created: .issues/${created.filename}` }],
        details: { id: created.id, filepath: created.filepath },
      };
    },
  });

  pi.registerTool({
    name: 'issue_list',
    label: 'List Issues',
    description: 'List issues from the local .issues/ directory.',
    parameters: Type.Object({
      status: Type.Optional(StringEnum(['open', 'in_progress', 'done', 'closed'])),
      type: Type.Optional(StringEnum(['initiative', 'epic', 'story', 'task', 'bug'])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issuesDir = path.join(ctx.cwd, '.issues');
      if (!fs.existsSync(issuesDir)) {
        return { content: [{ type: 'text', text: 'No issues.' }], details: { issues: [] } };
      }

      const issues: string[] = [];
      const files = fs.readdirSync(issuesDir).filter((file) => file.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(issuesDir, file), 'utf-8');
        const fm = parseFrontmatter(content);

        const id = fm.id ?? '?????';
        const status = fm.status ?? 'unknown';
        const type = fm.type ?? 'unknown';
        const title = fm.title ?? 'untitled';

        if (params.status && params.status !== status) continue;
        if (params.type && params.type !== type) continue;

        const em = (TYPE_EMOTICONS as Record<string, string>)[type] ?? ' ';
        issues.push(`[${id}] ${em} ${String(type).padEnd(10)} | ${String(status).padEnd(12)} | ${title}`);
      }

      return {
        content: [{ type: 'text', text: issues.sort().join('\n') || 'None found.' }],
        details: { issues },
      };
    },
  });

  pi.registerTool({
    name: 'issue_read',
    label: 'Read Issue',
    description: 'Read the full content of a specific issue.',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issuesDir = path.join(ctx.cwd, '.issues');
      const id = sanitizeSingleLine(params.id);
      if (!id) throw new Error('ID required.');

      const files = fs.readdirSync(issuesDir).filter((file) => file.endsWith('.md') && file.startsWith(`${id}-`));
      if (files.length !== 1) throw new Error('Not found.');

      const file = files[0] as string;
      return {
        content: [{ type: 'text', text: fs.readFileSync(path.join(issuesDir, file), 'utf-8') }],
        details: { file },
      };
    },
  });

  pi.registerTool({
    name: 'issue_comment',
    label: 'Add Comment',
    description: 'Add a structured update/comment to an issue.',
    parameters: Type.Object({
      id: Type.String(),
      update: Type.String(),
      artifacts: Type.Optional(Type.String()),
      next_steps: Type.Optional(Type.String()),
      blockers: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issuesDir = path.join(ctx.cwd, '.issues');
      const id = sanitizeSingleLine(params.id);
      if (!id) throw new Error('ID required.');

      const files = fs.readdirSync(issuesDir).filter((file) => file.endsWith('.md') && file.startsWith(`${id}-`));
      if (files.length !== 1) throw new Error('Not found.');

      const file = files[0] as string;
      const filePath = path.join(issuesDir, file);
      const current = fs.readFileSync(filePath, 'utf-8');
      const date = new Date().toISOString().split('T')[0];

      let comment = `\n### Update: ${date}\n\n`;
      comment += `**Status Update:**\n${typeof params.update === 'string' ? params.update : ''}\n\n`;
      if (typeof params.artifacts === 'string' && params.artifacts.trim()) {
        comment += `**Artifacts:**\n${params.artifacts}\n\n`;
      }
      if (
        (typeof params.next_steps === 'string' && params.next_steps.trim()) ||
        (typeof params.blockers === 'string' && params.blockers.trim())
      ) {
        comment += '**Next Steps / Blockers:**\n';
        if (typeof params.next_steps === 'string' && params.next_steps.trim()) {
          comment += `- Next: ${params.next_steps}\n`;
        }
        if (typeof params.blockers === 'string' && params.blockers.trim()) {
          comment += `- Blocked by: ${params.blockers}\n`;
        }
        comment += '\n';
      }
      comment += `opencode-agent: ${sanitizeSingleLine(params.author, 'agent')}\n`;

      fs.writeFileSync(filePath, `${current}\n---\n${comment}`, 'utf-8');
      return { content: [{ type: 'text', text: `Comment added to ${file}` }], details: { file } };
    },
  });
}
