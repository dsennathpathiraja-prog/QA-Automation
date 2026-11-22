import { assessAcCoverage, renderAcCoverageMarkdown } from './case-quality-gate';
import type { PlannerScenario, ScenarioKind, ScenarioPriority, SurfaceKind } from './types';

export interface PlanMarkdownMeta {
  workItem: string;
  application: string;
  criteria?: string[];
  findings?: string;
  source?: string;
  /** Weak / mismatched Explore UI note (duplicate shop snapshots, template WI, etc.). */
  exploreWarning?: string;
  /** Structural fail-closed gap — wrong surface only. */
  blockingGap?: boolean;
  surfaceKind?: SurfaceKind;
  primarySurfaceUrl?: string;
  candidateRoutes?: string[];
}

const kindOf = (raw: string): ScenarioKind => {
  const k = raw.toLowerCase();
  if (k.includes('negative')) return 'negative';
  if (k.includes('edge')) return 'edge';
  return 'positive';
};

const priorityOf = (kind: ScenarioKind, raw?: string): ScenarioPriority => {
  const p = (raw ?? '').toLowerCase();
  if (p === 'high' || p === 'medium' || p === 'low') return p;
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

/**
 * Persist a durable Markdown test plan for playwright-test-planner output.
 * playwright-test-generator consumes this artifact (not a sparse 3-case summary alone).
 */
export function renderPlanMarkdown(scenarios: PlannerScenario[], meta: PlanMarkdownMeta): string {
  const lines: string[] = [
    `# Test plan: ${meta.workItem} — ${meta.application}`,
    '',
    '## Context',
    '',
    `- **Work item:** ${meta.workItem}`,
    `- **Application:** ${meta.application}`,
    `- **Scenarios:** ${scenarios.length}`,
    meta.source ? `- **Planner source:** ${meta.source}` : '',
    '',
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));

  if (meta.criteria && meta.criteria.length > 0) {
    lines.push('## Acceptance criteria', '');
    for (const c of meta.criteria) lines.push(`- ${c}`);
    lines.push('');
  }

  if (meta.surfaceKind || meta.primarySurfaceUrl || (meta.candidateRoutes && meta.candidateRoutes.length > 0)) {
    lines.push('## Story surface binding', '');
    if (meta.surfaceKind) lines.push(`- **Surface kind:** ${meta.surfaceKind}`);
    lines.push(meta.primarySurfaceUrl
      ? `- **Primary validation URL:** ${meta.primarySurfaceUrl}`
      : '- **Primary validation URL:** _(not bound — no matching WI URL or explore hit)_');
    if (meta.candidateRoutes && meta.candidateRoutes.length > 0) {
      lines.push(`- **Candidate routes:** ${meta.candidateRoutes.slice(0, 8).map((r) => `\`${r}\``).join(', ')}`);
    }
    lines.push('');
  }

  if (meta.blockingGap) {
    lines.push(
      '## Explore surface gap (blocking)',
      '',
      meta.exploreWarning?.trim()
        || 'Explore only reached a mismatched surface for this work item. Template/email scenarios are **Blocked / needs-surface** — do not treat shop/catalog coverage as a pass.',
      '',
    );
  } else if (meta.exploreWarning?.trim()) {
    lines.push('## Explore coverage warning', '', meta.exploreWarning.trim(), '');
  }

  if (meta.findings?.trim()) {
    lines.push('## Exploration findings', '', meta.findings.trim(), '');
  }

  lines.push('## Scenarios', '');
  scenarios.forEach((scenario, index) => {
    lines.push(`### ${index + 1}. ${scenario.name}`);
    lines.push('');
    lines.push(`- **Kind:** ${scenario.kind}`);
    lines.push(`- **Priority:** ${scenario.priority}`);
    lines.push(`- **Criterion:** ${scenario.criterion}`);
    lines.push(`- **Steps:** ${scenario.steps}`);
    lines.push(`- **Expected:** ${scenario.expected}`);
    lines.push('');
  });

  if (meta.criteria && meta.criteria.length > 0) {
    const coverageMd = renderAcCoverageMarkdown(
      assessAcCoverage({ criteria: meta.criteria, scenarios }),
    );
    if (coverageMd) lines.push(coverageMd.trimEnd(), '');
  }

  return `${lines.join('\n').trim()}\n`;
}

/** Parse scenarios back out of a plan Markdown artifact (generator / healer input). */
export function parsePlanMarkdown(markdown: string): PlannerScenario[] {
  const body = markdown.replace(/\r/g, '');
  const chunks = body.split(/^###\s+\d+\.\s+/m).slice(1);
  const scenarios: PlannerScenario[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const name = (lines[0] ?? '').trim();
    if (!name) continue;
    const field = (label: string) => {
      const re = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, 'im');
      const hit = chunk.match(re);
      return hit?.[1]?.trim() ?? '';
    };
    const kind = kindOf(field('Kind') || name);
    const steps = field('Steps');
    const expected = field('Expected');
    const criterion = field('Criterion') || name;
    if (!steps || !expected) continue;
    scenarios.push({
      name,
      kind,
      priority: priorityOf(kind, field('Priority')),
      criterion,
      steps,
      expected,
    });
  }
  return scenarios;
}

/** Stable relative path for the plan artifact in the platform workspace. */
export function planArtifactPath(workItem: string, application: string): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
  return `plans/${slug(application)}/${slug(workItem)}.plan.md`;
}
