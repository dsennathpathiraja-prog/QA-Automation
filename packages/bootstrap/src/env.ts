export type Env = Readonly<Record<string, string | undefined>>;

export function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
