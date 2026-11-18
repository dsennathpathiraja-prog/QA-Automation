export const WORKFLOW_TYPES = ['requirement-validation', 'regression-testing'] as const;
export type WorkflowKind = (typeof WORKFLOW_TYPES)[number];

export interface WfParameter {
  name: string;
  type: string;
  required: boolean;
  pinned?: unknown;
  default?: unknown;
}

export interface WfConnector {
  role: string;
  category: string;
  requiredCapabilities: string[];
  optionalCapabilities?: string[];
  optional?: boolean;
  binding?: { connectorInstanceId: string | null };
}

export interface WfStep {
  id: string;
  type: string;
  typeVersion: number;
  enabled?: boolean;
  mandatory?: boolean;
  locked?: boolean | string[];
  dependsOn?: string[];
  config?: Record<string, unknown>;
  inputs?: Record<string, string>;
  retry?: { maxAttempts: number; backoff?: string; initialDelaySec?: number; retryOn?: string[] };
  timeoutMinutes?: number;
  pause?: 'safe' | 'boundary' | 'never';
}

export interface WfDef {
  schemaVersion: '1.0';
  kind: 'WorkflowDefinition';
  metadata: {
    key: string;
    name: string;
    description: string;
    type: WorkflowKind;
    typeVersion: number;
    templateRef: { key: string; version: number } | null;
  };
  spec: {
    parameters: WfParameter[];
    connectors: WfConnector[];
    environment: {
      mode: string;
      allowedKinds: string[];
      pinnedEnvironmentId: string | null;
      production: { allowed: boolean; requiresApproval: boolean };
    };
    execution: {
      maxParallelism: number;
      timeoutMinutes: number;
      onStepFailure: string;
      schedule: { enabled: boolean; cron: string | null; timezone: string } | null;
      retention: { artifactDays: number };
    };
    approvals: { id: string; gate: string; stepId: string | null; when: string; approverRoles: string[] }[];
    policy: { capabilityDeny: string[] };
    steps: WfStep[];
  };
}

export interface BoundInstance {
  role: string;
  category: string;
  enabled: boolean;
  health: 'healthy' | 'degraded' | 'unhealthy';
  accessMode: 'read_only' | 'read_write';
  capabilities: string[];
}

export interface ValidateCtx {
  instances: BoundInstance[];
  environment?: { kind: string; enabled: boolean; productionAuthorized: boolean } | null;
}

export interface ValidationIssue {
  ruleId: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  fixHint: string;
}
