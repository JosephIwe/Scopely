// Production smoke test. Read-only and signed out: it creates no account, workspace or row, calls
// no provider and contacts no business. One sign-in attempt with an address on the reserved
// `.invalid` domain checks the refusal; it counts once against the attempt limiter.
//
//   node scripts/smoke.mjs https://scopely-production.up.railway.app
const base = (process.argv[2] ?? process.env.SCOPELY_PUBLIC_URL ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
  console.error('usage: node scripts/smoke.mjs https://<host>');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
const write = (method, path, body, headers = { 'x-scopely-request': '1' }) =>
  get(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Railway may still be switching traffic to a new deploy; wait for a healthy answer first.
let health = null;
for (let i = 0; i < 30; i++) {
  try {
    const r = await get('/healthz');
    if (r.status === 200) { health = { status: r.status, body: await r.json(), headers: r.headers }; break; }
  } catch { /* not up yet */ }
  await new Promise((s) => setTimeout(s, 10_000));
}
check('GET /healthz is 200, schema current, sign-in mode', health && health.body.ok === true && health.body.pendingMigrations === 0 && health.body.auth === 'session',
  health ? JSON.stringify(health.body) : 'no healthy answer in 5 minutes');
check('HSTS is sent', health?.headers.get('strict-transport-security')?.includes('max-age='));

const home = await get('/');
check('GET / (landing page) is 200 HTML', home.status === 200 && home.headers.get('content-type')?.startsWith('text/html'), String(home.status));

const app = await get('/app/');
const appHtml = app.status === 200 ? await app.text() : '';
check('GET /app/ is 200', app.status === 200 && appHtml.includes('<'), String(app.status));
check('App sends a CSP that blocks framing', /frame-ancestors 'none'/.test(app.headers.get('content-security-policy') ?? ''));
check('App sends nosniff', app.headers.get('x-content-type-options') === 'nosniff');

const sess = await get('/api/session');
const s = sess.status === 200 ? await sess.json() : null;
check('GET /api/session: signed out, invite-only', s && s.mode === 'session' && s.signedIn === false && s.openSignup === false, JSON.stringify(s));

const opps = await get('/api/opportunities');
check('GET /api/opportunities signed out is 401', opps.status === 401, String(opps.status));

const ws = await get('/api/workspace');
check('GET /api/workspace signed out is 401', ws.status === 401, String(ws.status));

const csrf = await write('POST', '/api/session', { email: 'smoke@example.invalid', password: 'x'.repeat(12) }, {});
check('POST without the request header is 403', csrf.status === 403, String(csrf.status));

const cross = await write('POST', '/api/session', { email: 'smoke@example.invalid', password: 'x'.repeat(12) },
  { 'x-scopely-request': '1', origin: 'https://evil.example' });
check('POST from another origin is 403', cross.status === 403, String(cross.status));

const bad = await write('POST', '/api/session', { email: 'smoke@example.invalid', password: 'not-a-real-password' });
check('Sign-in with an unknown account is refused (401) and sets no cookie', bad.status === 401 && !bad.headers.get('set-cookie'), String(bad.status));

const signup = await write('POST', '/api/signup', { email: 'smoke@example.invalid', password: 'not-a-real-password', workspaceName: 'Smoke' });
check('Sign-up without an invite is refused (403)', signup.status === 403, String(signup.status));

const invite = await write('POST', '/api/invites/check', { token: 'not-a-real-token' });
check('An unknown invite token is refused (404)', invite.status === 404, String(invite.status));

const send = await write('POST', '/api/opportunities/1/drafts/1/send', {});
check('There is no send route (401 signed out, never 2xx)', send.status === 401 || send.status === 404, String(send.status));

if (base.startsWith('https:')) {
  const http = await fetch(base.replace(/^https:/, 'http:') + '/healthz', { redirect: 'manual' }).catch(() => null);
  check('Plain HTTP does not serve the app', !http || (http.status >= 300 && http.status < 400), http ? String(http.status) : 'refused');
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed against ${base} at ${new Date().toISOString()}`);
process.exit(failed ? 1 : 0);
