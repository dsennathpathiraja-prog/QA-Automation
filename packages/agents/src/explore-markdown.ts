import { parseMcpPageSnapshot, snapshotArtifactBody } from './snapshot-content';
import type { CodeFinding, ExploreClickOutcome, ExploreFinding } from './types';

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

function cueList(label: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return [`- **${label}:** ${values.slice(0, 12).map((v) => `\`${v}\``).join(', ')}`];
}

function renderClickOutcome(o: ExploreClickOutcome): string[] {
  const lines = [
    `### Clicked ${o.kind} \`${o.control}\``,
    '',
    `- **Result:** ${o.result}`,
    `- **URL:** \`${o.urlBefore}\` → \`${o.urlAfter}\``,
  ];
  if (o.headingBefore || o.headingAfter) {
    lines.push(`- **Heading:** ${o.headingBefore ? `"${o.headingBefore}"` : '_(none)_'} → ${o.headingAfter ? `"${o.headingAfter}"` : '_(none)_'}`);
  }
  lines.push(`- **Change:** ${o.changeSummary}`);
  if (o.disabledBefore?.length) {
    lines.push(`- **Disabled before:** ${o.disabledBefore.slice(0, 10).map((d) => `\`${d}\``).join(', ')}`);
  }
  if (o.disabledAfter?.length) {
    lines.push(`- **Disabled after:** ${o.disabledAfter.slice(0, 10).map((d) => `\`${d}\``).join(', ')}`);
  }
  if (o.newlyEnabled?.length) {
    lines.push(`- **Became enabled:** ${o.newlyEnabled.slice(0, 10).map((d) => `\`${d}\``).join(', ')}`);
  }
  lines.push('');
  return lines;
}

/** Markdown for Explore UI findings (URLs + structured a11y / YAML snapshots). */
export function renderExploreUiMarkdown(input: {
  workItem: string;
  application: string;
  findings: string;
  details?: ExploreFinding[];
  surfaceKind?: string;
  primarySurfaceUrl?: string;
  blockingGap?: boolean;
  candidateRoutes?: string[];
  pagesVisited?: number;
  exploredUrls?: string[];
  clickOutcomes?: ExploreClickOutcome[];
}): string {
  const lines = [
    `# Explore UI: ${input.workItem} — ${input.application}`,
    '',
    '## Findings',
    '',
    input.findings.trim() || '_(none)_',
    '',
  ];
  const pageCount = input.pagesVisited
    ?? input.exploredUrls?.length
    ?? input.details?.length
    ?? 0;
  const explored = input.exploredUrls
    ?? [...new Set((input.details ?? []).map((d) => d.url).filter(Boolean))];
  if (pageCount > 0 || explored.length > 0) {
    lines.push('## Multi-page explore', '');
    lines.push(`- **Pages explored:** ${pageCount || explored.length}`);
    if (explored.length > 0) {
      lines.push(`- **URLs:** ${explored.map((u) => `\`${u}\``).join(', ')}`);
    }
    if (input.clickOutcomes && input.clickOutcomes.length > 0) {
      const clicked = input.clickOutcomes.filter((o) => o.result !== 'skipped-disabled').length;
      lines.push(`- **Control clicks recorded:** ${clicked}`);
    }
    lines.push('');
  }
  if (input.clickOutcomes && input.clickOutcomes.length > 0) {
    lines.push('## Click findings', '');
    lines.push('Each systematically attempted control with before→after UI observations:', '');
    for (const o of input.clickOutcomes) {
      lines.push(...renderClickOutcome(o));
    }
  }
  if (input.surfaceKind || input.primarySurfaceUrl || input.blockingGap || (input.candidateRoutes && input.candidateRoutes.length > 0)) {
    lines.push('## Story surface binding', '');
    if (input.surfaceKind) lines.push(`- **Surface kind:** ${input.surfaceKind}`);
    lines.push(input.primarySurfaceUrl
      ? `- **Primary validation URL:** ${input.primarySurfaceUrl}`
      : '- **Primary validation URL:** _(not bound)_');
    if (input.candidateRoutes && input.candidateRoutes.length > 0) {
      lines.push(`- **Candidate routes:** ${input.candidateRoutes.slice(0, 8).map((r) => `\`${r}\``).join(', ')}`);
    }
    if (input.blockingGap) {
      lines.push('- **Blocking gap:** true — mismatched surface; do not Pass email/template ACs on this host');
    }
    lines.push('');
  }
  if (input.details && input.details.length > 0) {
    lines.push('## Pages', '');
    for (const d of input.details) {
      const parsed = parseMcpPageSnapshot(d.snapshotExcerpt || '');
      if (!parsed.url) parsed.url = d.url;
      if (!parsed.title && d.title) parsed.title = d.title;
      const body = snapshotArtifactBody(parsed) || (d.snapshotExcerpt || '').trim();
      lines.push(`### ${d.scenarioName}`);
      lines.push('');
      lines.push(`- **URL:** ${parsed.url || d.url}`);
      if (parsed.title) lines.push(`- **Title:** ${parsed.title}`);
      if (d.viaClick) lines.push(`- **Via click:** \`${d.viaClick}\``);
      if (d.screenshotBase64) lines.push('- **Screenshot:** captured');
      lines.push(...cueList('Headings', parsed.cues.headings));
      lines.push(...cueList('Buttons', parsed.cues.buttons));
      lines.push(...cueList('Links', parsed.cues.links));
      lines.push(...cueList('Fields', parsed.cues.fields));
      if (d.cuesSummary && !parsed.cues.buttons.length && !parsed.cues.links.length) {
        lines.push(`- **Cues:** ${d.cuesSummary}`);
      }
      lines.push('');
      if (body) {
        lines.push('#### Accessibility snapshot');
        lines.push('');
        lines.push('```yaml');
        lines.push(body.slice(0, 4_000));
        lines.push('```');
        lines.push('');
      } else {
        // Should not appear on successful Explore UI — empty snapshots fail the step.
        lines.push('- **Snapshot:** _(empty — Explore UI should have failed)_');
        lines.push('');
      }
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
