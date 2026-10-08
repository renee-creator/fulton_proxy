// TREE server (Fulton proxy)
// Forwards documentation generator requests to the Anthropic API.
// Every failure returns a clear message. Nothing here can stop the server.
//
// Open this service's address in a browser to see a status page that says
// whether everything works and, when it does not, exactly what to fix.

const http = require('http');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_TOKENS = 2500;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000;

// Models are tried in this order. If Anthropic retires one, the next takes over.
// Set ANTHROPIC_MODEL on Render to put a different model first.
const MODELS = [process.env.ANTHROPIC_MODEL, 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6']
  .map(m => (m || '').trim())
  .filter((m, i, all) => m && all.indexOf(m) === i);
let modelIndex = 0;
// Extra settings for a model. Haiku 5.5 thinks before it answers, so it gets more room for the answer and low effort thinking.
const MODEL_SETTINGS = { 'claude-haiku-5-5': { max_tokens: 5000, output_config: { effort: 'low' } } };

// Websites allowed to send analysis requests. Add more on Render with ALLOWED_ORIGINS, comma separated.
// A future iPhone app built with Capacitor sends the origin capacitor://localhost.
// School sign-in. Set SCHOOL_PASSCODES on Render to turn it on. Without it the server works as before.
// Several passcodes are separated by commas. An entry may carry a name, as in  Fulton=maple garden 42
// Passcodes are compared without regard to capitals or extra spaces. They are never printed or logged.
function normCode(s) { return String(s == null ? '' : s).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function codeHash(s) { return crypto.createHash('sha256').update(s, 'utf8').digest(); }
const PASSCODE_ENTRIES = String(process.env.SCHOOL_PASSCODES || '').split(',').filter(entry => entry.trim()).map(entry => {
  const cut = entry.indexOf('=');
  const name = cut > 0 ? entry.slice(0, cut).trim() : '';
  const code = normCode(cut > 0 ? entry.slice(cut + 1) : entry);
  return { name: /^[A-Za-z0-9 _.&-]{1,40}$/.test(name) ? name : '', ok: code.length >= 6, hash: codeHash(code) };
});
const PASSCODES = PASSCODE_ENTRIES.filter(p => p.ok);
const PASSCODES_TOO_SHORT = PASSCODE_ENTRIES.length - PASSCODES.length;   // shorter than six characters, so not used
const LOCKED = PASSCODES.length > 0;
function matchPasscode(given) {
  if (typeof given !== 'string' || !given || given.length > 200) return null;
  const h = codeHash(normCode(given));
  let hit = null;
  for (const p of PASSCODES) if (crypto.timingSafeEqual(h, p.hash)) hit = p;
  return hit;
}
// Ten wrong tries from one address in ten minutes and that address has to wait.
const wrongTries = new Map();
const TRY_LIMIT = 10, TRY_WINDOW_MS = 10 * 60 * 1000;
function clientAddress(req) {
  const fwd = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function tooManyTries(who) { const t = wrongTries.get(who); return !!t && t.until > Date.now() && t.count >= TRY_LIMIT; }
function noteWrongTry(who) {
  const now = Date.now();
  if (wrongTries.size > 5000) wrongTries.clear();
  const t = wrongTries.get(who);
  if (!t || t.until <= now) wrongTries.set(who, { count: 1, until: now + TRY_WINDOW_MS }); else t.count++;
}

const ALLOWED_ORIGINS = ['https://renee-creator.github.io']
  .concat((process.env.ALLOWED_ORIGINS || '').split(','))
  .map(s => s.trim().replace(/\/+$/, '').toLowerCase())
  .filter(Boolean);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// Removes spaces, line breaks, quote marks and invisible characters that ride along with a paste.
function cleanKey(raw) {
  return String(raw).replace(/[\s"'\u200B-\u200D\uFEFF]/g, '');
}

// Finds the Anthropic key. It normally lives in ANTHROPIC_API_KEY, but a key saved on
// Render under any other variable name is found too.
function findKey() {
  const env = process.env;
  const candidates = [];
  if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim()) candidates.push(['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY]);
  for (const name of Object.keys(env)) {
    if (name === 'ANTHROPIC_API_KEY' || typeof env[name] !== 'string') continue;
    if (cleanKey(env[name]).startsWith('sk-ant-')) candidates.push([name, env[name]]);
  }
  let problem = null;
  for (const [name, raw] of candidates) {
    const key = cleanKey(raw);
    let state = 'ok';
    if (!key) state = 'missing';
    else if (!/^[\x21-\x7E]+$/.test(key)) state = 'badchars';
    else if (!key.startsWith('sk-ant-')) state = 'wrongformat';
    else if (key.indexOf('..') >= 0 || key.length < 40) state = 'shortened';
    if (state === 'ok') return { state, key, name };
    if (!problem) problem = { state, key: '', name };
  }
  return problem || { state: 'missing', key: '', name: '' };
}

function safeName(name) {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name || '') && !/sk-ant/i.test(name) ? name : 'a Render variable';
}

function keyMessage(k) {
  const where = k.name ? ' (variable ' + safeName(k.name) + ')' : '';
  switch (k.state) {
    case 'missing': return 'No Anthropic API key is saved on Render. Open the service on Render, choose Environment, add a variable named ANTHROPIC_API_KEY with the full key as its value, then choose Save, rebuild, and deploy.';
    case 'badchars': return 'The API key saved on Render' + where + ' contains characters that do not belong in a key. Delete the value and paste the full key again.';
    case 'wrongformat': return 'The value saved on Render' + where + ' does not start with sk-ant- so it is not an Anthropic API key. Delete the value and paste the full key again.';
    case 'shortened': return 'The value saved on Render' + where + ' is the shortened display form of a key, which cannot be used. Create a new key in the Anthropic Console, copy it while it is shown in full, and paste it into Render.';
    default: return '';
  }
}

function send(res, status, headers, body) {
  try {
    if (res.headersSent || res.writableEnded) { try { res.end(); } catch (e) {} return; }
    res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, CORS, headers));
    res.end(body);
  } catch (e) {
    console.error('Could not send response', e && e.message);
  }
}

function sendJson(res, status, obj) { send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj)); }

function deny(res, status, message) {
  sendJson(res, status, { type: 'error', error: { type: 'access_denied', message } });
}

function fail(res, status, message) {
  console.error('Request failed', status, message);
  sendJson(res, status, { type: 'error', error: { type: 'proxy_error', message } });
}

// Sends one request to Anthropic. Calls done(err, status, bodyText) exactly once.
function requestAnthropic(key, payload, done) {
  let finished = false;
  const finish = (err, status, text) => { if (!finished) { finished = true; done(err, status, text); } };
  let apiReq;
  try {
    const body = JSON.stringify(payload);
    apiReq = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }
    }, apiRes => {
      const chunks = [];
      apiRes.on('data', c => chunks.push(c));
      apiRes.on('error', e => finish(e));
      apiRes.on('aborted', () => finish(new Error('Anthropic closed the connection early')));
      apiRes.on('end', () => finish(null, apiRes.statusCode || 502, Buffer.concat(chunks).toString('utf8')));
    });
    apiReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => apiReq.destroy(new Error('Anthropic did not answer in time')));
    apiReq.on('error', e => finish(e));
    apiReq.end(body);
  } catch (e) {
    finish(e);
  }
  return () => { try { if (apiReq) apiReq.destroy(); } catch (e) {} };
}

function isRetiredModel(status, text) {
  if (status !== 404) return false;
  try { return JSON.parse(text).error.type === 'not_found_error'; } catch (e) { return false; }
}

// Asks Anthropic with the current model and moves to the next model when one has been retired.
function callAnthropic(key, maxTokens, content, done) {
  let cancel = () => {};
  let cancelled = false;
  const attempt = () => {
    const model = MODELS[modelIndex];
    const body = Object.assign({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }, MODEL_SETTINGS[model] || {});
    cancel = requestAnthropic(key, body, (err, status, text) => {
      if (cancelled) return;
      if (!err && isRetiredModel(status, text) && modelIndex < MODELS.length - 1) {
        console.error('Model ' + model + ' is not available. Switching to ' + MODELS[modelIndex + 1]);
        modelIndex++;
        attempt();
        return;
      }
      done(err, status, text);
    });
  };
  attempt();
  return () => { cancelled = true; cancel(); };
}

// Status page. One tiny test request is made and the result is kept for a few minutes.
let lastTest = { at: 0, ok: false, line: '' };
let testRunning = null;

function runSelfTest() {
  if (testRunning) return testRunning;
  testRunning = new Promise(resolve => {
    const k = findKey();
    if (k.state !== 'ok') { resolve({ ok: false, line: keyMessage(k) }); return; }
    const found = k.name === 'ANTHROPIC_API_KEY' ? '' : ' The key was found in the Render variable named ' + safeName(k.name) + '.';
    callAnthropic(k.key, 5, 'Reply with OK', (err, status, text) => {
      if (err) { resolve({ ok: false, line: 'Could not reach Anthropic. ' + err.message }); return; }
      if (status === 200) { resolve({ ok: true, line: 'Anthropic accepted a test request. AI analysis is ready.' + found }); return; }
      let detail = '';
      try { detail = JSON.parse(text).error.message || ''; } catch (e) {}
      if (status === 401) { resolve({ ok: false, line: 'Anthropic rejected the API key. Create a new key in the Anthropic Console, copy it while it is shown in full, and paste it into Render. ' + detail }); return; }
      resolve({ ok: false, line: 'Anthropic answered with error ' + status + '. ' + detail });
    });
  }).then(r => { lastTest = { at: Date.now(), ok: r.ok, line: r.line }; testRunning = null; return lastTest; },
          () => { testRunning = null; return { ok: false, line: 'The self test could not run.' }; });
  return testRunning;
}

function statusPage(res) {
  const fresh = lastTest.at && Date.now() - lastTest.at < (lastTest.ok ? 300000 : 20000);
  (fresh ? Promise.resolve(lastTest) : runSelfTest()).then(t => {
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TREE server status</title></head>' +
      '<body style="font-family:system-ui,sans-serif;font-size:18px;line-height:1.5;max-width:640px;margin:32px auto;padding:0 16px">' +
      '<h1 style="font-size:22px">TREE server status</h1>' +
      '<p>The TREE server is running.</p>' +
      '<p style="font-weight:600;color:' + (t.ok ? '#1a7f37' : '#b42318') + '">' + (t.ok ? 'WORKING. ' : 'NOT WORKING. ') + esc(t.line) + '</p>' +
      '<p style="color:#555;font-size:15px">Model in use ' + esc(MODELS[modelIndex]) + '</p>' +
      '<p style="color:#555;font-size:15px">' + (LOCKED ? 'School sign-in is on. Passcodes set ' + PASSCODES.length + '.' : 'School sign-in is off. Anyone who opens the generator can run analyses.') + (PASSCODES_TOO_SHORT ? ' ' + PASSCODES_TOO_SHORT + ' passcode on Render is shorter than six characters and is being ignored.' : '') + '</p></body></html>';
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
  }).catch(e => { console.error('Status page error', e && e.message); try { res.end(); } catch (e2) {} });
}

function handle(req, res) {
  req.on('error', e => console.error('Incoming request error', e && e.message));
  res.on('error', e => console.error('Outgoing response error', e && e.message));

  if (req.method === 'GET' || req.method === 'HEAD') {
    req.resume();
    const path = (req.url || '/').split('?')[0];
    if (path === '/health') { sendJson(res, 200, { ok: true, locked: LOCKED }); return; }   // wakes the server, costs nothing
    if (path === '/' || path === '/status') { statusPage(res); return; }
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    return;
  }

  if (req.method === 'OPTIONS') { req.resume(); send(res, 204, {}, undefined); return; }
  if (req.method !== 'POST') { req.resume(); fail(res, 405, 'Method not allowed'); return; }

  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (ALLOWED_ORIGINS.indexOf(rawOrigin.replace(/\/+$/, '').toLowerCase()) < 0) {
    req.resume();
    fail(res, 403, 'This website is not allowed to use the AI server. Open the generator at ' + ALLOWED_ORIGINS[0] + ' instead. Origin received was ' + (rawOrigin || 'none') + '.');
    return;
  }

  const chunks = [];
  let size = 0;
  let tooBig = false;
  let cancelUpstream = null;

  res.on('close', () => { if (!res.writableEnded && cancelUpstream) cancelUpstream(); });

  req.on('data', chunk => {
    if (tooBig) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooBig = true;
      chunks.length = 0;
      fail(res, 413, 'The photos are too large to send. Use fewer or smaller photos.');
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooBig) return;
    try {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { fail(res, 400, 'Request body is not valid JSON'); return; }

      const path = (req.url || '/').split('?')[0];
      let school = '';
      if (LOCKED) {
        const who = clientAddress(req);
        if (tooManyTries(who)) { deny(res, 429, 'Too many wrong passcode tries. Wait ten minutes and try again.'); return; }
        const hit = matchPasscode(parsed && typeof parsed === 'object' ? parsed.access : undefined);
        if (!hit) { noteWrongTry(who); deny(res, 403, 'This tool needs your school passcode. Reload the page and sign in.'); return; }
        school = hit.name;
      }
      if (path === '/check') { sendJson(res, 200, { ok: true, locked: LOCKED }); return; }

      const content = parsed && typeof parsed === 'object' ? parsed.content : undefined;
      const usable = (typeof content === 'string' && content.length > 0) || (Array.isArray(content) && content.length > 0);
      if (!usable) { fail(res, 400, 'Request is missing content'); return; }

      const k = findKey();
      if (k.state !== 'ok') { fail(res, 500, keyMessage(k)); return; }

      if (LOCKED) console.log('Analysis requested' + (school ? ' by ' + school : ''));
      cancelUpstream = callAnthropic(k.key, MAX_TOKENS, content, (err, status, text) => {
        if (err) { fail(res, 502, 'Could not reach Anthropic. ' + err.message); return; }
        if (status !== 200) console.error('Anthropic answered', status, String(text).slice(0, 500));
        send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, text);
      });
    } catch (e) {
      fail(res, 500, 'Proxy error. ' + (e && e.message));
    }
  });
}

const server = http.createServer((req, res) => {
  try { handle(req, res); }
  catch (e) { fail(res, 500, 'Proxy error. ' + (e && e.message)); }
});

server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) {} });
server.on('error', e => { console.error('Server could not start', e && e.message); process.exit(1); });
process.on('uncaughtException', e => console.error('Unexpected error, server kept running', e && e.stack));
process.on('unhandledRejection', e => console.error('Unexpected rejection, server kept running', e));

server.listen(PORT, () => {
  const k = findKey();
  console.log('Proxy running on port ' + PORT);
  console.log('Models ' + MODELS.join(', '));
  console.log(k.state === 'ok' ? 'API key loaded from ' + safeName(k.name) : 'API KEY PROBLEM. ' + keyMessage(k));
  console.log(LOCKED ? 'School sign-in is on. Passcodes set ' + PASSCODES.length : 'School sign-in is off');
  if (PASSCODES_TOO_SHORT) console.log('A passcode shorter than six characters was ignored');
  // One-time model comparison, only when MODEL_TEST=run is set.
  if (process.env.MODEL_TEST === 'run' && k.state === 'ok') setTimeout(() => { try { require('./modeltest')(k.key, requestAnthropic); } catch (e) { console.error('MODELTEST failed to start', e && e.message); } }, 3000);
});
