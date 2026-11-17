export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

const TOKEN_RULES: [string, RegExp][] = [
  ['GitHub token', /\b(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/** Configuration-style assignments of a literal credential, for example `password: hunter2hunter2`. */
const ASSIGNMENT = /(?:^|[\s"',])([A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|token|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"',}#]+)/i;
const SAFE_VALUE = /^(\$\{|\$[A-Z_]|<|\/run\/secrets\/|\/etc\/|file:|true$|false$|null$|\{\{|%)/;
const CONFIG_FILE = /\.(ya?ml|env|hcl|conf|json|toml|properties|sh)$|(^|\/)\.env(\.|$)|Dockerfile$/;

/** Paths where fixed values are intentional and documented. Each entry needs a reason. */
export const SECRET_SCAN_ALLOWLIST: { prefix: string; reason: string }[] = [
  { prefix: 'deploy/compose/local/', reason: 'local trial stack: fixed throw-away passwords on localhost, never for shared hosts' },
  { prefix: 'pnpm-lock.yaml', reason: 'integrity hashes' },
  { prefix: '.github/workflows/ci.yml', reason: 'credentials of the ephemeral Postgres service container that exists only during a CI run' },
];

const isTest = (f: string) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.test\.tsx?$/.test(f);

export function scanText(file: string, text: string): SecretFinding[] {
  if (SECRET_SCAN_ALLOWLIST.some((a) => file.startsWith(a.prefix))) return [];
  const out: SecretFinding[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    for (const [rule, re] of TOKEN_RULES) {
      if (re.test(raw)) out.push({ file, line: i + 1, rule });
    }
    if (CONFIG_FILE.test(file) && !isTest(file)) {
      const m = ASSIGNMENT.exec(raw);
      if (m && m[2]!.length >= 6 && !SAFE_VALUE.test(m[2]!) && !/_FILE$/i.test(m[1]!) && m[1] !== 'secrets' && !/(role[_-]?id|secret[_-]?id|_path|_ttl|_uses|_url|_locator|_ref)$/i.test(m[1]!)) {
        out.push({ file, line: i + 1, rule: `literal value for ${m[1]}` });
      }
    }
  });
  return out;
}
