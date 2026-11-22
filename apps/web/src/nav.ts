import type { Permission } from '@qa/contracts';

export type NavGroup = 'main' | 'config' | 'admin';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  group: NavGroup;
  /** Visible when the user holds any of these. Omitted means every signed-in user. The server re-checks everything. */
  anyOf?: readonly Permission[];
  /** Roadmap phase that delivers the screen, shown on placeholder pages. */
  phase: number;
  summary: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', to: '/', group: 'main', phase: 9, summary: 'Overview of runs, approvals and connector health.' },
  { id: 'workflows', label: 'Workflows', to: '/workflows', group: 'main', anyOf: ['workflow.view_published', 'workflow.create'], phase: 4, summary: 'Templates, the builder, publish, and the run wizard.' },
  { id: 'executions', label: 'Executions', to: '/executions', group: 'main', anyOf: ['execution.start', 'execution.control'], phase: 7, summary: 'Prepare work-item runs, open Regression entry points, and review live evidence.' },
  { id: 'test-cases', label: 'Test Cases', to: '/test-cases', group: 'main', anyOf: ['testcase.view'], phase: 6, summary: 'Collections of generated cases, grouped by kind and priority.' },
  { id: 'automation', label: 'Automation Mapping', to: '/automation', group: 'main', anyOf: ['automation.view'], phase: 9, summary: 'Approve Squash↔script mappings; Regression prep lists approved vs Not Automated before execute.' },
  { id: 'evidence', label: 'Evidence', to: '/evidence', group: 'main', anyOf: ['evidence.view'], phase: 9, summary: 'Browse screenshots captured on finished Regression and work-item runs.' },
  { id: 'reports', label: 'Reports & Analytics', to: '/reports', group: 'main', anyOf: ['report.view'], phase: 9, summary: 'Readable pass/fail reports and regression-report.md for finished runs.' },
  { id: 'connectors', label: 'Connectors', to: '/connectors', group: 'config', anyOf: ['connector.view_status', 'connector.manage'], phase: 2, summary: 'Work items, source repositories, test management and browser automation.' },
  { id: 'environments', label: 'Environments', to: '/environments', group: 'config', anyOf: ['environment.view'], phase: 3, summary: 'Application environments, authentication profiles and restrictions.' },
  { id: 'agents', label: 'AI Agents', to: '/agents', group: 'config', anyOf: ['agent.view'], phase: 5, summary: 'System agents, their settings and run history.' },
  { id: 'models', label: 'AI Models', to: '/models', group: 'config', anyOf: ['llm.view'], phase: 5, summary: 'Local model providers, qualification and per-agent assignment.' },
  { id: 'identity', label: 'Users & Identity mapping', to: '/admin/identity', group: 'admin', anyOf: ['user.manage'], phase: 10, summary: 'How identity provider groups map to platform roles.' },
  { id: 'hosts', label: 'Approved hosts', to: '/admin/hosts', group: 'admin', anyOf: ['security.policy.manage'], phase: 2, summary: 'The outbound allowlist and external model approvals.' },
  { id: 'security', label: 'Security & Approvals', to: '/admin/security', group: 'admin', anyOf: ['security.policy.manage'], phase: 10, summary: 'Approval policies and production authorizations.' },
  { id: 'audit', label: 'Audit Log', to: '/admin/audit', group: 'admin', anyOf: ['audit.read'], phase: 10, summary: 'Who did what, tamper-evident.' },
  { id: 'settings', label: 'System Settings', to: '/admin/settings', group: 'admin', anyOf: ['security.policy.manage'], phase: 10, summary: 'Retention, concurrency caps and sign-in settings.' },
];

export const GROUP_LABEL: Record<NavGroup, string> = { main: 'Work', config: 'Configuration', admin: 'Administration' };

export const visibleNav = (canAny: (p: readonly Permission[] | undefined) => boolean): NavItem[] => NAV_ITEMS.filter((i) => canAny(i.anyOf));
