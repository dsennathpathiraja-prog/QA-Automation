import type { CodeFinding, ExploreFinding } from './types';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

/** Relative path for the Read work-item Markdown artifact. */
export function storyArtifactPath(workItem: string, application: string): string {
  return `explore/${slug(application)}/${slug(workItem)}.story.md`;
}

/** Relative path for Explore UI Markdown. */
export function exploreUiArtifactPath(workItem: string, application: string): string {
  return `explore/${slug(application)}/${slug(workItem)}.ui.md`;
}

/** Relative path for Explore code Markdown. */
export function exploreCodeArtifactPath(workItem: string, application: string): string {
  return `explore/${slug(application)}/${slug(workItem)}.code.md`;
}

/** Markdown operators can open to verify the Read step loaded real Boards/Jira data. */
export function renderStoryMarkdown(input: {
  workItem: string;
  application: string;
  title?: string;
  story: string;
  acceptanceCriteria?: string[];
  descriptionExcerpt?: string;
}): string {
  const lines = [
    `# Work item ${input.workItem}${input.title ? ` — ${input.title}` : ''}`,
    '',
    '## Context',
    '',
    `- **Work item:** ${input.workItem}`,
    `- **Application:** ${input.application}`,
    input.title ? `- **Title:** ${input.title}` : '- **Title:** _(not loaded)_',
    '',
  ];
  if (input.descriptionExcerpt?.trim()) {
    lines.push('## Description excerpt', '', input.descriptionExcerpt.trim(), '');
  }
  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria', '');
    for (const c of input.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push('## Story blob', '', '```', input.story.trim() || '(empty)', '```', '');
  return `${lines.join('\n').trim()}\n`;
}

/** Markdown for Explore UI findings (URLs + snapshot excerpts). */
export function renderExploreUiMarkdown(input: {
  workItem: string;
  application: string;
  findings: string;
  details?: ExploreFinding[];
}): string {
  const lines = [
    `# Explore UI: ${input.workItem} — ${input.application}`,
    '',
    '## Findings',
    '',
    input.findings.trim() || '_(none)_',
    '',
  ];
  if (input.details && input.details.length > 0) {
    lines.push('## Pages', '');
    for (const d of input.details) {
      lines.push(`### ${d.scenarioName}`);
      lines.push('');
      lines.push(`- **URL:** ${d.url}`);
      lines.push(`- **Snapshot:** ${(d.snapshotExcerpt || '').replace(/\s+/g, ' ').slice(0, 500) || '_(empty)_'}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

/** Markdown for Explore code findings (real Azure Repos / GitHub paths). */
export function renderExploreCodeMarkdown(input: {
  workItem: string;
  application: string;
  findings: string;
  details?: CodeFinding[];
  repo?: string;
}): string {
  const lines = [
    `# Explore code: ${input.workItem} — ${input.application}`,
    '',
    '## Context',
    '',
    `- **Work item:** ${input.workItem}`,
    `- **Application:** ${input.application}`,
    `- **Repository:** ${input.repo?.trim() || 'bound source-repo connector'}`,
    '',
    '## Findings',
    '',
    input.findings.trim() || '_(none)_',
    '',
  ];
  if (input.details && input.details.length > 0) {
    lines.push('## Visited files', '');
    for (const d of input.details) {
      lines.push(`### \`${d.path}\``);
      lines.push('');
      if (d.query) lines.push(`- **Query:** ${d.query}`);
      lines.push('```');
      lines.push((d.excerpt || '').slice(0, 800) || '(empty)');
      lines.push('```');
      lines.push('');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}
