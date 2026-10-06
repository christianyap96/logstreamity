// server/local-proxy.mjs  (zero dependencies, Node 18+)
// Serves this repo's static files AND forwards Dynatrace API calls, so the browser only ever talks to
// http://127.0.0.1:<port> (same origin: no CORS). Run:  node server/local-proxy.mjs   (or run-local-proxy.cmd)
//
// Safety: binds to 127.0.0.1 only; refuses requests whose Host/Origin is not this proxy; forwards only to
// *.dynatrace.com / *.dynatracelabs.com; forwards only Authorization / Content-Type / Accept; drops cookies;
// never logs headers, bodies or query strings (tokens stay out of the console).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 128 * 1024 * 1024; // lookup uploads are limited to 100 MB by Dynatrace
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const FORWARD_REQ = ['authorization', 'content-type', 'accept'];
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'keep-alive']);

export const defaultHostAllowed = (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(dynatrace\.com|dynatracelabs\.com)$/i.test(h || '');

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('Request body too large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

export function createProxyServer({ upstream = (url, init) => fetch(url, init), hostAllowed = defaultHostAllowed, root = ROOT, quiet = true } = {}) {
  async function proxy(req, res, u) {
    const rest = u.pathname.slice('/_dtproxy/'.length);
    const i = rest.indexOf('/');
    const host = (i < 0 ? rest : rest.slice(0, i)).toLowerCase();
    const tail = i < 0 ? '/' : rest.slice(i);
    if (!hostAllowed(host)) return send(res, 403, `Host not allowed: only *.dynatrace.com and *.dynatracelabs.com`);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, 'Method not allowed');
    const target = `https://${host}${tail}${u.search}`;
    const headers = {};
    for (const k of FORWARD_REQ) if (req.headers[k]) headers[k] = req.headers[k];
    const body = (req.method === 'GET') ? undefined : await readBody(req);
    const r = await upstream(target, { method: req.method, headers, body: body && body.length ? body : undefined, redirect: 'manual' });
    const out = Buffer.from(await r.arrayBuffer());
    const rh = { 'Cache-Control': 'no-store' };
    r.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) rh[k] = v; });
    res.writeHead(r.status, rh); res.end(out);
    if (!quiet) console.log(`${req.method} ${host}${tail.split('?')[0].slice(0, 80)} -> ${r.status}`);
  }

  function serveStatic(req, res, u) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel; try { rel = decodeURIComponent(u.pathname); } catch { return send(res, 400, 'Bad path'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const segs = rel.split('/').filter(Boolean);
    if (segs.some(s => s.startsWith('.') || s === 'node_modules' || s === 'server')) return send(res, 404, 'Not found');
    const file = path.resolve(root, '.' + path.sep + segs.join(path.sep));
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const hostHdr = String(req.headers.host || '').toLowerCase();
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHdr)) return send(res, 403, 'Forbidden host header');
      const origin = req.headers.origin;
      if (origin) { let oh = ''; try { oh = new URL(origin).host.toLowerCase(); } catch { /* ignore */ } if (oh !== hostHdr) return send(res, 403, 'Cross-origin request refused'); }
      const u = new URL(req.url, 'http://local');
      if (u.pathname === '/_dtproxy/health') return send(res, 200, JSON.stringify({ proxy: true }), { 'Content-Type': 'application/json' });
      if (u.pathname.startsWith('/_dtproxy/')) return await proxy(req, res, u);
      return serveStatic(req, res, u);
    } catch (e) {
      send(res, e && e.code === 413 ? 413 : 502, `Proxy error: ${e && e.message || e}`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const srv = createProxyServer({ quiet: false });
  srv.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT=8081 and retry.` : e.message); process.exit(1); });
  srv.listen(port, '127.0.0.1', () => {
    console.log(`Logstreamity local proxy running.\n  Open:  http://127.0.0.1:${port}/platform.html\n  Forwards only to *.dynatrace.com / *.dynatracelabs.com. Press Ctrl+C to stop.`);
  });
}
