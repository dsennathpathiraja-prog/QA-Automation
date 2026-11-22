/**
 * Phase 8 E3 — Case quality gate before publish.
 * Refuses body-only stubs; flags AC coverage gaps and explore-gap / needs-surface cases.
 */

import { PlatformError } from '@qa/domain';
import { isStubPlaywrightSource } from './playwright-source';
import { isNeedsSurfaceCase, NEEDS_SURFACE_TAG } from './surface-binding';
import type { GeneratedPlaywrightCase, PlannerScenario } from './types';

export type CaseQualityCode =
  | 'stub-forbidden'
  | 'ac-coverage-gap'
  | 'explore-gap'
  | 'empty-corpus';

export interface CaseQualityIssue {
  code: CaseQualityCode;
  severity: 'error' | 'warning';
  message: string;
  caseName?: string;
  criterion?: string;
}

export interface AcCoverageRow {
  criterion: string;
  covered: boolean;
  scenarioNames: string[];
}

export interface CaseQualityReport {
  /** False when any error-severity issue is present (publish must refuse). */
  ok: boolean;
  issues: CaseQualityIssue[];
  acCoverage: AcCoverageRow[];
  stubCount: number;
  needsSurfaceCount: number;
  caseCount: number;
  summary: string;
}

export interface CaseQualityGateInput {
  cases: Array<
    Pick<GeneratedPlaywrightCase, 'name' | 'steps' | 'expected'> & {
      tags?: string[];
      runStatus?: 'Blocked' | 'Skipped';
      criterion?: string;
    }
  >;
  /** Acceptance criteria from the work item / plan. */
  criteria?: string[];
  /** Planned scenarios (preferred for AC coverage matching). */
  scenarios?: PlannerScenario[];
  planMarkdown?: string;
  /** Explore reported a blocking surface gap. */
  blockingGap?: boolean;
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

const tokens = (value: string): string[] => normalize(value)
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 4);

/** Pull acceptance-criteria bullets from a plan Markdown artifact. */
export function criteriaFromPlanMarkdown(markdown?: string): string[] {
  if (!markdown?.trim()) return [];
  const body = markdown.replace(/\r/g, '');
  const start = body.search(/^##\s+Acceptance criteria\s*$/im);
  if (start < 0) return [];
  const rest = body.slice(start).split(/\n(?=##\s+)/)[0] ?? '';
  return rest
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line && !/^##\s+/.test(line) && !/^acceptance criteria$/i.test(line));
}

function criterionCoveredBy(
  criterion: string,
  scenarios: PlannerScenario[],
  cases: CaseQualityGateInput['cases'],
): string[] {
  const crit = normalize(criterion);
  const critTokens = new Set(tokens(criterion));
  const hits: string[] = [];
  const consider = (name: string, blob: string) => {
    const n = normalize(name);
    const b = normalize(blob);
    if (!n && !b) return;
    if (crit && (b.includes(crit) || n.includes(crit) || crit.includes(n))) {
      hits.push(name);
      return;
    }
    if (critTokens.size === 0) return;
    const blobTokens = new Set(tokens(`${name} ${blob}`));
    let overlap = 0;
    for (const t of critTokens) if (blobTokens.has(t)) overlap += 1;
    if (overlap >= Math.min(2, critTokens.size) || (critTokens.size === 1 && overlap === 1)) {
      hits.push(name);
    }
  };
  for (const s of scenarios) {
    consider(s.name, `${s.criterion} ${s.steps} ${s.expected}`);
  }
  for (const c of cases) {
    consider(c.name, `${c.criterion ?? ''} ${c.expected} ${c.steps.slice(0, 400)}`);
  }
  return [...new Set(hits)];
}

/** Map each acceptance criterion to covering scenario/case names. */
export function assessAcCoverage(input: {
  criteria: string[];
  scenarios?: PlannerScenario[];
  cases?: CaseQualityGateInput['cases'];
}): AcCoverageRow[] {
  const scenarios = input.scenarios ?? [];
  const cases = input.cases ?? [];
  return input.criteria.map((criterion) => {
    const scenarioNames = criterionCoveredBy(criterion, scenarios, cases);
    return { criterion, covered: scenarioNames.length > 0, scenarioNames };
  });
}

function formatIssueLine(issue: CaseQualityIssue): string {
  const where = issue.caseName ? ` [${issue.caseName}]` : issue.criterion ? ` (AC: ${issue.criterion.slice(0, 80)})` : '';
  return `${issue.severity === 'error' ? 'ERROR' : 'WARN'} ${issue.code}${where}: ${issue.message}`;
}

/**
 * Evaluate pre-publish case quality.
 * Errors (refuse publish): body-only / stub cases.
 * Warnings (flag, still publish): AC coverage gaps, explore-gap / needs-surface cases.
 */
export function evaluateCaseQualityGate(input: CaseQualityGateInput): CaseQualityReport {
  const cases = input.cases ?? [];
  const criteria = (input.criteria && input.criteria.length > 0)
    ? input.criteria
    : criteriaFromPlanMarkdown(input.planMarkdown);
  const planned = input.scenarios ?? [];
  const acCoverage = criteria.length > 0
    ? assessAcCoverage({ criteria, scenarios: planned, cases })
    : [];

  const issues: CaseQualityIssue[] = [];
  let stubCount = 0;
  let needsSurfaceCount = 0;

  for (const item of cases) {
    if (isStubPlaywrightSource(item.steps)) {
      stubCount += 1;
      issues.push({
        code: 'stub-forbidden',
        severity: 'error',
        caseName: item.name,
        message: 'Body-only / stub Playwright (locator("body").toBeVisible) is forbidden before publish. Heal or regenerate with scenario-specific steps.',
      });
    }
    const needsSurface = item.runStatus === 'Blocked'
      || item.tags?.includes(NEEDS_SURFACE_TAG)
      || isNeedsSurfaceCase(item);
    if (needsSurface) {
      needsSurfaceCount += 1;
      issues.push({
        code: 'explore-gap',
        severity: 'warning',
        caseName: item.name,
        message: `Case is flagged ${NEEDS_SURFACE_TAG} / Blocked for explore surface gap — will not Pass on a mismatched host.`,
      });
    }
  }

  if (input.blockingGap && needsSurfaceCount === 0 && cases.length > 0) {
    issues.push({
      code: 'explore-gap',
      severity: 'warning',
      message: 'Plan reported a blocking explore gap, but no case is tagged needs-surface. Review generate/heal output before trusting publish.',
    });
  }

  for (const row of acCoverage.filter((r) => !r.covered)) {
    issues.push({
      code: 'ac-coverage-gap',
      severity: 'warning',
      criterion: row.criterion,
      message: 'No planned scenario or generated case clearly covers this acceptance criterion.',
    });
  }

  if (cases.length === 0) {
    issues.push({
      code: 'empty-corpus',
      severity: 'warning',
      message: 'No cases to publish.',
    });
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const gapCount = acCoverage.filter((r) => !r.covered).length;
  const parts = [
    errors.length > 0
      ? `Refused: ${errors.length} quality error${errors.length === 1 ? '' : 's'} (stubs forbidden).`
      : 'Quality gate passed (no stub errors).',
    stubCount > 0 ? `${stubCount} stub case${stubCount === 1 ? '' : 's'}.` : '',
    needsSurfaceCount > 0 ? `${needsSurfaceCount} explore-gap / ${NEEDS_SURFACE_TAG}.` : '',
    gapCount > 0 ? `${gapCount} AC coverage gap${gapCount === 1 ? '' : 's'}.` : '',
    warnings.length > 0 && errors.length === 0 ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}.` : '',
  ].filter(Boolean);

  return {
    ok: errors.length === 0,
    issues,
    acCoverage,
    stubCount,
    needsSurfaceCount,
    caseCount: cases.length,
    summary: parts.join(' '),
  };
}

/** Human-readable refusal text for step.failed / API / UI. */
export function formatQualityGateRefusal(report: CaseQualityReport): string {
  const lines = [
    'Publish refused by case quality gate.',
    report.summary,
    ...report.issues.filter((i) => i.severity === 'error').map(formatIssueLine),
    ...report.issues.filter((i) => i.severity === 'warning').slice(0, 8).map(formatIssueLine),
  ];
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/** Throw PlatformError('validation') when stubs (or other errors) block publish. */
export function assertPublishQualityGate(input: CaseQualityGateInput): CaseQualityReport {
  const report = evaluateCaseQualityGate(input);
  if (!report.ok) {
    throw new PlatformError('validation', formatQualityGateRefusal(report), {
      qualityGate: {
        stubCount: report.stubCount,
        needsSurfaceCount: report.needsSurfaceCount,
        acGaps: report.acCoverage.filter((r) => !r.covered).map((r) => r.criterion),
        issues: report.issues,
      },
    });
  }
  return report;
}

/** Markdown section for plan artifacts listing covered vs gap ACs. */
export function renderAcCoverageMarkdown(rows: AcCoverageRow[]): string {
  if (rows.length === 0) return '';
  const lines: string[] = ['## AC coverage', ''];
  const covered = rows.filter((r) => r.covered);
  const gaps = rows.filter((r) => !r.covered);
  if (covered.length > 0) {
    lines.push('### Covered', '');
    for (const row of covered) {
      const via = row.scenarioNames.slice(0, 3).map((n) => `\`${n}\``).join(', ');
      lines.push(`- ${row.criterion}${via ? ` — ${via}` : ''}`);
    }
    lines.push('');
  }
  if (gaps.length > 0) {
    lines.push('### Gaps (flagged)', '');
    for (const row of gaps) lines.push(`- ${row.criterion}`);
    lines.push('');
  } else {
    lines.push('_All listed acceptance criteria have at least one scenario._', '');
  }
  return `${lines.join('\n').trim()}\n`;
}
