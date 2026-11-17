/**
 * Read-only guard for GraphQL POST bodies: rejects any document containing a top-level
 * `mutation` or `subscription` operation. Strings and comments are stripped before scanning
 * so they cannot hide or fake operations.
 */
export function isReadOnlyGraphQL(body: string): boolean {
  let query: string;
  try {
    const parsed = JSON.parse(body) as { query?: unknown };
    if (typeof parsed.query !== 'string') return false;
    query = parsed.query;
  } catch {
    return false;
  }
  const stripped = stripStringsAndComments(query);
  if (stripped === undefined) return false;
  let depth = 0;
  let token = '';
  const check = (): boolean => {
    const t = token;
    token = '';
    return depth === 0 && (t === 'mutation' || t === 'subscription');
  };
  for (const ch of stripped) {
    if (/[A-Za-z_]/.test(ch) || (token && /[0-9]/.test(ch))) {
      token += ch;
      continue;
    }
    if (check()) return false;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) return false;
  }
  if (check()) return false;
  return depth === 0;
}

function stripStringsAndComments(s: string): string | undefined {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i += 1;
      out += '\n';
    } else if (s.startsWith('"""', i)) {
      const end = s.indexOf('"""', i + 3);
      if (end === -1) return undefined;
      i = end + 2;
      out += ' ';
    } else if (ch === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i += 1;
        i += 1;
      }
      if (i >= s.length) return undefined;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}
