import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

const timeoutMs = 8_000;
const target = process.env.QA_TARGET_URL ?? '';
const allowed = (process.env.QA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';

const finish = (status, text) => {
  console.log(text);
  process.exit(status);
};

const hostAllowed = (hostname, port) => {
  const host = hostname.toLowerCase();
  const withPort = port ? `${host}:${port}` : host;
  return allowed.some((rule) => {
    if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
    return rule === host || rule === withPort;
  });
};

let url;
try {
  url = new URL(target);
} catch {
  finish(1, 'did not answer');
}
if (!hostAllowed(url.hostname, url.port)) finish(1, 'host not allowed');

const report = (status) => finish(status >= 200 && status < 500 ? 0 : 1, `answered ${status}`);

try {
  const status = proxy ? await throughProxy(url, proxy) : await direct(url);
  report(status);
} catch {
  finish(1, 'did not answer');
}

function direct(u) {
  return fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }).then((res) => res.status);
}

function throughProxy(u, proxyUrl) {
  const p = new URL(proxyUrl);
  if (u.protocol === 'http:') return plain(p, { method: 'GET', path: u.href, headers: { host: u.host, accept: '*/*' } });
  return new Promise((resolve, reject) => {
    const req = httpRequest({ protocol: p.protocol, hostname: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, timeout: timeoutMs });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('proxy refused'));
        return;
      }
      const tls = tlsConnect({ socket, servername: u.hostname });
      tls.once('secureConnect', () => {
        tls.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      });
      let raw = '';
      tls.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      tls.once('error', reject);
      tls.once('end', () => {
        const code = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(raw)?.[1]);
        if (!code) reject(new Error('no status'));
        else resolve(code);
      });
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}

function plain(p, options) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ protocol: p.protocol, hostname: p.hostname, port: p.port || 80, timeout: timeoutMs, ...options }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}
