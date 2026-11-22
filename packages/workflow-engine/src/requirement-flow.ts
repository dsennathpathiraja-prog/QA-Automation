import {
  generateWithPlaywrightGenerator,
  healWithPlaywrightHealer,
  planWithPlaywrightPlanner,
  type PlannerScenario,
} from './playwright-agents';

const slugPath = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

/** Optional Azure Boards fields from expand=All (worker enrich → Read story MD). */
export interface StoryWorkItemFields {
  type?: string;
  state?: string;
  areaPath?: string;
  iterationPath?: string;
  priority?: string;
  requirementType?: string;
  valueArea?: string;
  parentId?: string;
  descriptionHtml?: string;
  acceptanceCriteriaHtml?: string;
}

function asWorkItemFields(value: unknown): StoryWorkItemFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const o = value as Record<string, unknown>;
  const pick = (key: keyof StoryWorkItemFields) => {
    const raw = o[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  };
  return {
    ...(pick('type') ? { type: pick('type') } : {}),
    ...(pick('state') ? { state: pick('state') } : {}),
    ...(pick('areaPath') ? { areaPath: pick('areaPath') } : {}),
    ...(pick('iterationPath') ? { iterationPath: pick('iterationPath') } : {}),
    ...(pick('priority') ? { priority: pick('priority') } : {}),
    ...(pick('requirementType') ? { requirementType: pick('requirementType') } : {}),
    ...(pick('valueArea') ? { valueArea: pick('valueArea') } : {}),
    ...(pick('parentId') ? { parentId: pick('parentId') } : {}),
    ...(pick('descriptionHtml') ? { descriptionHtml: pick('descriptionHtml') } : {}),
    ...(pick('acceptanceCriteriaHtml') ? { acceptanceCriteriaHtml: pick('acceptanceCriteriaHtml') } : {}),
  };
}

/** Compact Markdown for the Read step so Run UI / planner can use loaded work item fields. */
function renderStoryArtifactMarkdown(input: {
  workItem: string;
  application: string;
  title: string;
  story: string;
  acceptanceCriteria: string[];
  descriptionExcerpt: string;
  fields?: StoryWorkItemFields;
}): string {
  const f = input.fields ?? {};
  const lines = [
    `# Work item ${input.workItem}${input.title ? ` — ${input.title}` : ''}`,
    '',
    '## Context',
    '',
    `- **Work item:** ${input.workItem}`,
    `- **Application:** ${input.application}`,
    input.title ? `- **Title:** ${input.title}` : '- **Title:** _(not loaded)_',
  ];
  if (f.type) lines.push(`- **Type:** ${f.type}`);
  if (f.state) lines.push(`- **State:** ${f.state}`);
  if (f.areaPath) lines.push(`- **Area path:** ${f.areaPath}`);
  if (f.iterationPath) lines.push(`- **Iteration path:** ${f.iterationPath}`);
  if (f.priority) lines.push(`- **Priority:** ${f.priority}`);
  if (f.requirementType) lines.push(`- **Requirement type:** ${f.requirementType}`);
  if (f.valueArea) lines.push(`- **Value area:** ${f.valueArea}`);
  if (f.parentId) lines.push(`- **Parent:** ${f.parentId}`);
  lines.push('');
  if (f.descriptionHtml) {
    lines.push('## Description', '', f.descriptionHtml, '');
  } else if (input.descriptionExcerpt) {
    lines.push('## Description excerpt', '', input.descriptionExcerpt, '');
  }
  if (f.acceptanceCriteriaHtml) {
    lines.push('## Acceptance criteria', '', f.acceptanceCriteriaHtml, '');
  } else if (input.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria', '');
    for (const c of input.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push('## Story blob', '', '```', input.story.trim() || '(empty)', '```', '');
  return `${lines.join('\n').trim()}\n`;
}

export interface FlowStep {
  id: string;
  type: string;
  params: Record<string, unknown>;
  prior: Record<string, Record<string, unknown>>;
}

export interface FlowCase {
  name: string;
  kind: PlannerScenario['kind'];
  priority: PlannerScenario['priority'];
  steps: string;
  expected: string;
  /** Human validation steps for Squash publish (optional; derived on publish when missing). */
  validationSteps?: { action: string; expected: string }[];
  workItem: string;
  reference: string;
  file: string;
  testId: string;
}

export interface FlowResult {
  summary: string;
  outputs: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const stripBullet = (line: string) => line.replace(/^[\s>*\-•\d.)]+/, '').trim();

const isSectionHeading = (line: string) => /^(#{1,6}\s|acceptance criteria\b|repro(duction)? steps\b|description\b|notes?\b|business rules?\b)/i.test(line.trim());

const isGwt = (line: string) => /^(given|when|then|and)\b/i.test(line);

/** First non-empty line is treated as the work item id when it looks like one. */
export function workItemIdFromStory(raw: string): string {
  const first = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const inline = first.match(/^(\d{1,10})\s*[—–:\-]\s+\S/)
    ?? first.match(/^([A-Z][A-Z0-9]+-\d+)\s*[—–:\-]\s+\S/i);
  if (inline?.[1]) return inline[1];
  if (/^\d{1,10}$/.test(first) || /^[A-Z][A-Z0-9]+-\d+$/i.test(first)) return first;
  return first.slice(0, 80);
}

/**
 * Title from a connector-enriched story blob: either `id — title` on the first line,
 * or the first non-empty line after the work-item id (matches storyFromWorkItem).
 */
export function workItemTitleFromStory(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n');
  const firstIdx = lines.findIndex((line) => line.trim());
  if (firstIdx < 0) return '';
  const first = (lines[firstIdx] ?? '').trim();
  const inline = first.match(/^(?:\d{1,10}|[A-Z][A-Z0-9]+-\d+)\s*[—–:\-]\s+(.+)$/i);
  if (inline?.[1]) {
    const titled = stripBullet(inline[1]).trim();
    if (titled && !isSectionHeading(titled) && !isGwt(titled)) return titled.slice(0, 200);
  }
  for (let i = firstIdx + 1; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    if (!rawLine.trim()) return '';
    const line = stripBullet(rawLine);
    if (!line || isSectionHeading(line) || isGwt(line)) return '';
    return line.slice(0, 200);
  }
  return '';
}

/**
 * Lines under an "Acceptance criteria" heading, Given/When/Then blocks, or bullets.
 * The work-item id on the first line is never treated as a criterion by itself.
 */
export function acceptanceLines(raw: string): string[] {
  const lines = raw.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => /acceptance criteria/i.test(line));
  const bodyLines = (start >= 0 ? lines.slice(start + 1) : lines).map((line) => line.trim());
  const kept: string[] = [];
  let gwt: string[] = [];
  const flushGwt = () => {
    if (gwt.length === 0) return;
    kept.push(gwt.join(' '));
    gwt = [];
  };
  for (const rawLine of bodyLines) {
    if (!rawLine) continue;
    if (start >= 0 && /^#{1,6}\s/.test(rawLine)) break;
    // Never treat the work-item id line (bare or `id — title`) as a criterion.
    if (/^(\d{1,10}|[A-Z][A-Z0-9]+-\d+)(\s*[—–:\-].*)?$/i.test(rawLine.trim())) {
      flushGwt();
      continue;
    }
    const line = stripBullet(rawLine);
    if (!line) continue;
    if (isSectionHeading(line) && !isGwt(line)) {
      flushGwt();
      continue;
    }
    if (isGwt(line)) {
      if (/^given\b/i.test(line) && gwt.length > 0) flushGwt();
      gwt.push(line);
      if (/^then\b/i.test(line)) flushGwt();
      continue;
    }
    flushGwt();
    kept.push(line);
  }
  flushGwt();

  const workItem = workItemIdFromStory(raw);
  const title = workItemTitleFromStory(raw);
  const withoutId = kept.filter((line) => (
    line !== workItem
    && line !== title
    && line.toLowerCase() !== 'acceptance criteria'
  ));
  if (withoutId.length > 0) return withoutId.slice(0, 40);

  // No AC heading: prefer bullets / GWT from the whole story, skipping the id line.
  const cues: string[] = [];
  gwt = [];
  for (const rawLine of lines.map((line) => line.trim()).filter(Boolean)) {
    if (/^(\d{1,10}|[A-Z][A-Z0-9]+-\d+)(\s*[—–:\-].*)?$/i.test(rawLine)) {
      if (gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      continue;
    }
    const line = stripBullet(rawLine);
    if (!line || line === workItem || line === title || isSectionHeading(line) && !isGwt(line)) {
      if (gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      continue;
    }
    if (isGwt(line)) {
      if (/^given\b/i.test(line) && gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      gwt.push(line);
      if (/^then\b/i.test(line)) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      continue;
    }
    if (/^([\-*•]|\d+[.)])\s+\S/.test(rawLine) || start < 0 && line.length >= 12 && line !== workItem && line !== title) {
      if (gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      cues.push(line);
    }
  }
  if (gwt.length > 0) cues.push(gwt.join(' '));
  return cues.slice(0, 40);
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []);

const priorityOf = (kind: PlannerScenario['kind'], raw: unknown): PlannerScenario['priority'] => {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

const scenariosOf = (value: unknown): PlannerScenario[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Partial<PlannerScenario>;
    const name = text(row.name);
    const kind = row.kind === 'negative' || row.kind === 'edge' ? row.kind : 'positive';
    const criterion = text(row.criterion) || name;
    const steps = text(row.steps);
    const expected = text(row.expected);
    if (!name || !steps || !expected) return [];
    return [{ name, kind, priority: priorityOf(kind, row.priority), criterion, steps, expected }];
  });
};

const validationStepsOf = (value: unknown): { action: string; expected: string }[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const steps = value.flatMap((item) => {
    const row = item as { action?: unknown; expected?: unknown };
    const action = text(row.action);
    if (!action) return [];
    return [{ action, expected: text(row.expected) }];
  });
  return steps.length > 0 ? steps : undefined;
};

const casesOf = (value: unknown): FlowCase[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Partial<FlowCase> & { validationSteps?: unknown };
    const name = text(row.name);
    const steps = text(row.steps);
    const expected = text(row.expected);
    if (!name || !steps || !expected) return [];
    const kind = row.kind === 'negative' || row.kind === 'edge' ? row.kind : 'positive';
    return [{
      name,
      kind,
      priority: priorityOf(kind, row.priority),
      steps,
      expected,
      validationSteps: validationStepsOf(row.validationSteps),
      workItem: text(row.workItem),
      reference: text(row.reference),
      file: text(row.file),
      testId: text(row.testId),
    }];
  });
};

/**
 * One requirement-validation stage.
 * Order: explore UI/code → consolidate → plan (MD) → generate → heal → publish.
 * This sync path is the offline / unit-test fallback: the worker binds Playwright
 * and source-repo connectors for real exploration before planning.
 */
export function runFlowStep(step: FlowStep): FlowResult {
  const story = text(step.params.story);
  const application = text(step.params.applicationName) || 'the application';
  const environment = text(step.params.environment);
  const storyOut = step.prior.read_story ?? {};
  const criteria = list(storyOut.acceptanceCriteria);
  const workItem = text(storyOut.workItem) || workItemIdFromStory(story) || 'work-item';
  const scenarios = scenariosOf(step.prior.plan?.scenarios);
  const planMarkdown = text(step.prior.plan?.planMarkdown);
  const planArtifact = text(step.prior.plan?.planArtifact);
  const findings = text(step.prior.consolidate?.findings)
    || text(step.prior.consolidate?.combined)
    || text(step.prior.explore_ui?.findings);
  const generatedCases = casesOf(step.prior.generate_tests?.cases);
  const healedCases = casesOf(step.prior.heal_tests?.cases);
  const cases = healedCases.length > 0 ? healedCases : generatedCases;

  switch (step.type) {
    case 'rv.read-user-story': {
      const found = acceptanceLines(story);
      const onlyId = found.length === 0 || (found.length === 1 && found[0] === workItem);
      const acceptanceCriteria = onlyId ? [] : found;
      const title = text(step.params.workItemTitle) || workItemTitleFromStory(story);
      const fetchNote = text(step.params.workItemFetchNote);
      const descriptionExcerpt = text(step.params.workItemDescriptionExcerpt);
      const fields = asWorkItemFields(step.params.workItemFields);
      const titled = title
        ? `Read work item ${workItem} — ${title}.`
        : `Read work item ${workItem || '(none)'}.`;
      const excerptPart = title && descriptionExcerpt ? ` ${descriptionExcerpt}` : '';
      const acPart = acceptanceCriteria.length > 0 || fields.acceptanceCriteriaHtml
        ? `${Math.max(acceptanceCriteria.length, fields.acceptanceCriteriaHtml ? 1 : 0)} acceptance criteria.`
        : 'The story text has no separate acceptance criteria, so the plan uses the work item itself.';
      const missPart = !title && fetchNote ? ` ${fetchNote}` : '';
      const storyMarkdown = renderStoryArtifactMarkdown({
        workItem,
        application,
        title,
        story,
        acceptanceCriteria,
        descriptionExcerpt,
        fields,
      });
      const storyArtifact = `explore/${slugPath(application)}/${slugPath(workItem)}.story.md`;
      return {
        summary: `${titled}${missPart}${excerptPart} ${acPart}`,
        outputs: {
          story,
          workItem,
          title: title || undefined,
          acceptanceCriteria,
          applicationName: application,
          environment,
          artifactMarkdown: storyMarkdown,
          artifactPath: storyArtifact,
          ...(descriptionExcerpt ? { descriptionExcerpt } : {}),
          ...(fetchNote ? { fetchNote } : {}),
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        },
      };
    }
    case 'rv.explore-ui':
      // Offline / unit-test stub only. The worker must wire createBrowserExplorer
      // so production never reaches this Done line without a real MCP session.
      {
        const findings = environment ? `environment ${environment}` : 'no environment';
        const artifactMarkdown = `# Explore UI: ${workItem} — ${application}\n\n## Findings\n\n${findings}\n\n_(offline stub — not a real browser session)_\n`;
        return {
          summary: environment
            ? `Offline UI stub for ${application} on ${environment}: worker did not drive Playwright (no browser explorer port).`
            : 'Offline UI stub: no environment and no browser explorer port — not a real Explore UI.',
          outputs: {
            findings,
            source: 'offline-stub',
            artifactMarkdown,
            artifactPath: `explore/${slugPath(application)}/${slugPath(workItem)}.ui.md`,
          },
        };
      }
    case 'rv.explore-code':
      // Offline / unit-test stub only. The worker must wire createCodeExplorer.
      {
        const findings = 'repository not read';
        const artifactMarkdown = `# Explore code: ${workItem} — ${application}\n\n## Findings\n\n${findings}\n\n_(offline stub — bind Azure DevOps Repos for real source)_\n`;
        return {
          summary: `Offline source stub for ${application}: worker did not search the bound repository (no code explorer port).`,
          outputs: {
            findings,
            source: 'offline-stub',
            artifactMarkdown,
            artifactPath: `explore/${slugPath(application)}/${slugPath(workItem)}.code.md`,
          },
        };
      }
    case 'rv.consolidate-findings': {
      const ui = text(step.prior.explore_ui?.findings);
      const code = text(step.prior.explore_code?.findings);
      const codeRelevant = step.prior.explore_code?.relevant !== false
        && !/Code explore not relevant|path-only|application-only/i.test(code);
      const uiRelevant = step.prior.explore_ui?.relevant !== false;
      const uiBlockingGap = step.prior.explore_ui?.blockingGap === true
        || /Blocking explore gap/i.test(ui);
      const surfaceKind = text(step.prior.explore_ui?.surfaceKind) || undefined;
      const primarySurfaceUrl = text(step.prior.explore_ui?.primarySurfaceUrl) || undefined;
      // Keep UI findings for gap messaging, but mark mismatched surfaces so planner/generator fail closed.
      const uiNote = ui
        ? (uiRelevant
          ? `UI: ${ui}`
          : `UI (surface mismatch — not valid coverage for email/template ACs): ${ui}`)
        : '';
      const codeNote = code
        ? (codeRelevant ? `Source: ${code}` : `Source (ignored — not relevant for scenarios): ${code.slice(0, 240)}`)
        : '';
      const combined = [uiNote, codeNote].filter(Boolean).join('\n') || 'no exploration findings';
      const gapNote = uiBlockingGap || !uiRelevant
        ? ' Explore UI marked not relevant / blocking surface gap — template scenarios must fail closed.'
        : '';
      return {
        summary: `Combined the story, the UI note, and the source note for the planner. ${criteria.length || 1} acceptance cue${(criteria.length || 1) === 1 ? '' : 's'} go forward.${code && !codeRelevant ? ' Code explore marked not relevant.' : ''}${gapNote}`,
        outputs: {
          workItem,
          findings: combined,
          combined,
          acceptanceCriteria: criteria,
          ...(uiBlockingGap ? { blockingGap: true } : {}),
          ...(surfaceKind ? { surfaceKind } : {}),
          ...(primarySurfaceUrl ? { primarySurfaceUrl } : {}),
          ...(uiRelevant === false ? { uiRelevant: false } : {}),
        },
      };
    }
    case 'rv.generate-test-plan': {
      const workItemTitle = text(storyOut.title) || workItemTitleFromStory(text(storyOut.story) || story);
      const planned = planWithPlaywrightPlanner({
        workItem,
        application,
        criteria,
        findings: findings || undefined,
        workItemTitle: workItemTitle || undefined,
      });
      return {
        summary: planned.summary,
        outputs: {
          scenarios: planned.scenarios,
          planMarkdown: planned.planMarkdown,
          planArtifact: planned.planArtifact,
          workItem,
          applicationName: application,
          environment,
          agent: 'playwright-test-planner',
        },
      };
    }
    case 'rv.generate-tests': {
      const workItemTitle = text(storyOut.title) || workItemTitleFromStory(text(storyOut.story) || story);
      const source = scenarios.length > 0
        ? scenarios
        : planWithPlaywrightPlanner({
          workItem,
          application,
          criteria,
          findings: findings || undefined,
          workItemTitle: workItemTitle || undefined,
        }).scenarios;
      const generated = generateWithPlaywrightGenerator({
        workItem,
        application,
        scenarios: source,
        planMarkdown: planMarkdown || undefined,
        findings: findings || undefined,
      });
      return {
        summary: generated.summary,
        outputs: {
          cases: generated.cases,
          workItem,
          planArtifact: planArtifact || undefined,
          agent: 'playwright-test-generator',
        },
      };
    }
    case 'rv.heal-tests': {
      const healed = healWithPlaywrightHealer({ workItem, cases: generatedCases });
      return {
        summary: healed.summary,
        outputs: {
          cases: healed.cases,
          fixed: healed.fixed,
          workItem,
          agent: 'playwright-test-healer',
        },
      };
    }
    case 'rv.publish-testcases':
      return {
        summary: cases.length > 0
          ? `Ready to store ${cases.length} test case${cases.length === 1 ? '' : 's'} for ${workItem} in Test Cases and in Squash.`
          : `No test cases were generated for ${workItem}. Nothing was sent to Squash.`,
        outputs: { cases, workItem, squash: 'read-write' },
      };
    case 'rv.execute-tests':
      return {
        summary: cases.length > 0
          ? `Recorded ${cases.length} case${cases.length === 1 ? '' : 's'} for execution under ${workItem}. Screenshots are not captured in this run.`
          : `No cases to execute for ${workItem}.`,
        outputs: { results: cases.map((item) => ({ name: item.name, status: 'recorded', workItem })) },
      };
    case 'rv.sync-results':
      return {
        summary: 'Execution results stay on this run. The generated test cases are stored in Squash when the publish step runs.',
        outputs: { squash: 'read-write' },
      };
    case 'rv.qa-report':
      return {
        summary: cases.length > 0
          ? `Report: ${cases.length} test case${cases.length === 1 ? '' : 's'} for ${workItem} are in Test Cases.`
          : `Report: no test cases were stored for ${workItem}.`,
        outputs: { workItem, count: cases.length },
      };
    default:
      return { summary: `Recorded ${step.id}.`, outputs: {} };
  }
}
