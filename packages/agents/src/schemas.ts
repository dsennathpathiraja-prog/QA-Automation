import { z } from 'zod';
import { fromZod } from '@qa/llm';
import { MAX_GENERATED_CASES, MAX_HEAL_CASES, MAX_PLAN_SCENARIOS } from './limits';

const Kind = z.enum(['positive', 'negative', 'edge']);
const Priority = z.enum(['high', 'medium', 'low']);

export const PlannerScenarioSchema = z.object({
  name: z.string().min(1).max(160),
  kind: Kind,
  priority: Priority.optional(),
  criterion: z.string().min(1).max(400),
  steps: z.string().min(1).max(2_000),
  expected: z.string().min(1).max(1_000),
});

export const PlanOutputSchema = z.object({
  scenarios: z.array(PlannerScenarioSchema).min(1).max(MAX_PLAN_SCENARIOS),
});

export const GeneratedCaseSchema = z.object({
  name: z.string().min(1).max(160),
  kind: Kind,
  priority: Priority.optional(),
  steps: z.string().min(1).max(8_000),
  expected: z.string().min(1).max(1_000),
  file: z.string().max(200).optional(),
  testId: z.string().max(80).optional(),
});

export const GenerateOutputSchema = z.object({
  cases: z.array(GeneratedCaseSchema).min(1).max(MAX_GENERATED_CASES),
});

export const HealOutputSchema = z.object({
  cases: z.array(GeneratedCaseSchema).min(1).max(MAX_HEAL_CASES),
});

export const planStructured = fromZod(PlanOutputSchema);
export const generateStructured = fromZod(GenerateOutputSchema);
export const healStructured = fromZod(HealOutputSchema);

export type PlanOutput = z.infer<typeof PlanOutputSchema>;
export type GenerateOutput = z.infer<typeof GenerateOutputSchema>;
export type HealOutput = z.infer<typeof HealOutputSchema>;
