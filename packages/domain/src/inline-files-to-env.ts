import { PlatformError } from './errors';
import { chunkEnvValue, type RunnerSpec } from './runner';

/**
 * Turn inlineFiles into chunked env vars so the launcher never needs Docker put-archive.
 * putFiles(400) is common with ReadonlyRootfs: /tmp is only a tmpfs after start, so archive
 * inject before start fails. Cases JSON is carried as QA_CASES_P* instead.
 */
export function materializeInlineFilesToEnv(spec: RunnerSpec): RunnerSpec {
  const files = spec.inlineFiles ?? [];
  if (files.length === 0) return spec;
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  for (const file of files) {
    const isCases = file.path.endsWith('qa-cases.json') || env.QA_CASES_FILE === file.path || env.QA_CASES_FILE?.endsWith('qa-cases.json');
    if (!isCases) {
      throw new PlatformError(
        'validation',
        `inlineFiles path "${file.path}" cannot be mounted (runner rootfs is read-only). Only qa-cases.json is supported via env chunks.`,
      );
    }
    Object.assign(env, chunkEnvValue('QA_CASES', file.content));
    delete env.QA_CASES_FILE;
    delete env.QA_CASES_JSON;
  }
  return { ...spec, env, inlineFiles: undefined };
}
