import { readFileSync } from 'node:fs';

/** Bootstrap secrets delivered as container secret files (e.g. /run/secrets/x). Trailing newline is stripped. */
export function readSecretFile(path: string): string {
  const v = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (v.length === 0) throw new Error(`secret file ${path} is empty`);
  return v;
}
