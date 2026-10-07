// Fulton proxy
// Forwards documentation generator requests to the Anthropic API.
// Every failure returns a clear message. Nothing here can stop the server.
//
// Open this service's address in a browser to see a status page that says
// whether everything works and, when it does not, exactly what to fix.

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_TOKENS = 2500;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000;

// Models are tried in this order. If Anthropic retires one, the next takes over.
// Set ANTHROPIC_MODEL on Render to put a different model first.
const MODELS = [process.env.ANTHROPIC_MODEL, 'claude-opus-4-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6']
  .map(m => (m || '').trim())
  .filter((m, i, all) => m && all.indexOf(m) === i);
let modelIndex = 0;

// Websites allowed to send analysis requests. Add more on Render with ALLOWED_ORIGINS, comma separated.
// A future iPhone app built with Capacitor sends the origin capacitor://localhost.
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
    cancel = requestAnthropic(key, { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }, (err, status, text) => {
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
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fulton proxy status</title></head>' +
      '<body style="font-family:system-ui,sans-serif;font-size:18px;line-height:1.5;max-width:640px;margin:32px auto;padding:0 16px">' +
      '<h1 style="font-size:22px">Fulton proxy status</h1>' +
      '<p>The proxy is running.</p>' +
      '<p style="font-weight:600;color:' + (t.ok ? '#1a7f37' : '#b42318') + '">' + (t.ok ? 'WORKING. ' : 'NOT WORKING. ') + esc(t.line) + '</p>' +
      '<p style="color:#555;font-size:15px">Model in use ' + esc(MODELS[modelIndex]) + '</p></body></html>';
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
  }).catch(e => { console.error('Status page error', e && e.message); try { res.end(); } catch (e2) {} });
}


// ---- Temporary model comparison. Runs one built-in sample observation on two models.
// It switches itself off at the time below, runs at most three times, and is removed in the next update.
const COMPARE_UNTIL = Date.parse('2026-10-07T04:30:00Z');
const COMPARE_MODELS = [['opus', 'claude-opus-4-5', 5, 25], ['haiku', 'claude-haiku-4-5-20251001', 1, 5]];
const COMPARE_PROMPT = "Analyze this early childhood documentation for DRDP (2025) measures.\nAge Group: Preschool/TK/K (3-6)\nDRDP Measures:\nATL (Approaches to Learning): ATL 1-Engagement, Attention, and Persistence, ATL 2-Curiosity, Interest, and Initiative, ATL 3-Problem-Solving, ATL 4-Planning\nSED (Social and Emotional Development): SED 1-Self-Awareness, SED 2-Social Awareness, SED 3-Relationships and Reciprocal Interactions with Familiar Adults, SED 4-Relationships and Interactions with Peers, SED 5-Emotional Knowledge and Regulation\nFLD (Foundational Language Development): FLD 1-Understanding Language (Receptive), FLD 2-Using Language (Expressive), FLD 3-Shared Communication and Conversation, FLD 4-Foundational Literacy Skills, FLD 5-Alphabetics and Print Knowledge, FLD 6-Writing\nELD (English Language Development): ELD 1-Comprehension of English (Receptive English), ELD 2-Self-Expression in English (Expressive English), ELD 3-Understanding and Responding to English Literacy Activities\nMATH (Math): MATH 1-Spatial Thinking, MATH 2-Classification, MATH 3-Number and Counting, MATH 4-Number Operations, MATH 5-Measurement\nSCI (Science): SCI 1-Cause and Effect, SCI 2-Inquiry Through Observation and Investigation, SCI 3-Documentation and Communication of Inquiry\nPD (Physical Development): PD 1-Perceptual-Motor Skills and Movement Concepts, PD 2-Gross Locomotor Movement Skills, PD 3-Gross Motor Manipulative Skills, PD 4-Fine Motor Manipulative Skills\nHLTH (Health): HLTH 1-Safety, HLTH 2-Understanding of Health and Wellness, HLTH 3-Personal Care Routines: Hygiene, HLTH 4-Personal Care Routines: Feeding, HLTH 5-Personal Care Routines: Self-Dressing\n\nDocumentation:\nSlide 1: Maya's Garden Discovery West Classroom Child: Maya (3 years, 2 months) Setting: Outdoor Garden Area Context: During free exploration time in our school garden, Maya discovered a ladybug on a leaf near the herb beds.\nSlide 2: What Happened The Observation Maya noticed a ladybug crawling on a basil leaf. She stopped and crouched down to look more closely. \u2022 She asked where it was going \u2713 She counted its spots with a teacher She said it was walking slow.\nSlide 3: What We Wonder How might we extend her curiosity about insects? \u2022 Add magnifying glasses to the garden \u2022 Read books about ladybugs together\n\nNo photos.\n\nUse only measure codes from the list above. slideNumbers lists the slides that show evidence for the measure.\nELD measures apply only when the documentation shows the child speaks a home language other than English and is learning English. Otherwise leave ELD out.\nestimatedLevel must be exactly one of these DRDP (2025) levels, from earliest to latest: Responding Earlier, Responding Later, Exploring Earlier, Exploring Middle, Exploring Later, Building Earlier, Building Middle, Building Later, Integrating Earlier, Integrating Middle, Integrating Later. For ELD measures use one of: Discovering Language, Discovering English, Exploring English, Developing English, Building English, Integrating English. HLTH 3, HLTH 4 and HLTH 5 end at Integrating Earlier. Choose the level the evidence best supports. If the evidence is too thin to estimate a level, use an empty string.\nReturn ONLY a JSON object. Use straight double quotes only. No apostrophes in values - rephrase instead. No newlines in string values. No trailing commas.\n{\"measures\":[{\"code\":\"ATL 1\",\"name\":\"measure name\",\"domain\":\"domain name\",\"domainCode\":\"ATL\",\"estimatedLevel\":\"Building Middle\",\"evidence\":\"specific evidence\",\"slideNumbers\":[1]}],\"photoAnalysis\":\"what the photos show\",\"narrativeSummary\":\"two sentence summary\"}";
let compareResults = null;
let compareRunning = null;
let compareAttempts = 0;
function runCompare() {
  if (compareResults) return Promise.resolve(compareResults);
  if (compareRunning) return compareRunning;
  const k = findKey();
  if (k.state !== 'ok') return Promise.resolve([{ tag: 'key', ok: false, out: 'KEY PROBLEM. ' + keyMessage(k) }]);
  if (compareAttempts >= 3) return Promise.resolve([{ tag: 'limit', ok: false, out: 'The comparison has already run three times.' }]);
  compareAttempts++;
  compareRunning = Promise.all(COMPARE_MODELS.map(([tag, model, pin, pout]) => new Promise(resolve => {
    const started = Date.now();
    requestAnthropic(k.key, { model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: COMPARE_PROMPT }] }, (err, status, text) => {
      if (err) { resolve({ tag, model, ok: false, out: 'ERROR ' + err.message }); return; }
      let j = null; try { j = JSON.parse(text); } catch (e) {}
      if (status !== 200 || !j) { resolve({ tag, model, ok: false, out: 'HTTP ' + status + ' ' + String(text).slice(0, 300) }); return; }
      const block = (j.content || []).find(c => c && c.type === 'text');
      const u = j.usage || {};
      const cost = ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout) / 1e6;
      resolve({ tag, model, ok: true, out: block ? String(block.text) : '', inTok: u.input_tokens, outTok: u.output_tokens, cost, ms: Date.now() - started, stop: j.stop_reason });
    });
  }))).then(results => {
    if (results.every(r => r.ok)) compareResults = results;
    compareRunning = null;
    return results;
  }, () => { compareRunning = null; return [{ tag: 'error', ok: false, out: 'The comparison could not run.' }]; });
  return compareRunning;
}
function compareDigest(r) {
  if (!r.ok) return 'MODEL ' + (r.model || r.tag) + '\nFAILED ' + r.out + '\n';
  const lines = ['MODEL ' + r.model, 'input_tokens ' + r.inTok, 'output_tokens ' + r.outTok, 'cost_usd ' + r.cost.toFixed(5),
    'seconds ' + (r.ms / 1000).toFixed(1), 'stop_reason ' + r.stop, 'answer_characters ' + r.out.length];
  try {
    const a = r.out.indexOf('{'), b = r.out.lastIndexOf('}');
    const o = JSON.parse(r.out.slice(a, b + 1));
    (o.measures || []).forEach((m, i) => lines.push('measure ' + (i + 1) + ' | ' + m.code + ' | ' + m.estimatedLevel + ' | slides ' + (m.slideNumbers || []).join(' ') + ' | evidence_characters ' + String(m.evidence || '').length));
    lines.push('summary_characters ' + String(o.narrativeSummary || '').length);
    lines.push('photo_characters ' + String(o.photoAnalysis || '').length);
  } catch (e) { lines.push('answer could not be read as JSON'); }
  return lines.join('\n') + '\n';
}
function compareView(results, part) {
  const one = results.find(r => r.tag === part);
  if (one) return one.out;
  return results.map(compareDigest).join('\n');
}

function handle(req, res) {
  req.on('error', e => console.error('Incoming request error', e && e.message));
  res.on('error', e => console.error('Outgoing response error', e && e.message));

  if (req.method === 'GET' || req.method === 'HEAD') {
    req.resume();
    const path = (req.url || '/').split('?')[0];
    if (path === '/health') { sendJson(res, 200, { ok: true }); return; }   // wakes the server, costs nothing
    if (path === '/' || path === '/status') { statusPage(res); return; }
    if (path === '/compare-sample') {
      if (Date.now() > COMPARE_UNTIL) { send(res, 410, { 'Content-Type': 'text/plain; charset=utf-8' }, 'The comparison has ended.'); return; }
      const part = (/[?&]part=([a-z]+)/.exec(req.url || '') || [])[1] || '';
      runCompare().then(r => send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, compareView(r, part)));
      return;
    }
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

      const content = parsed && typeof parsed === 'object' ? parsed.content : undefined;
      const usable = (typeof content === 'string' && content.length > 0) || (Array.isArray(content) && content.length > 0);
      if (!usable) { fail(res, 400, 'Request is missing content'); return; }

      const k = findKey();
      if (k.state !== 'ok') { fail(res, 500, keyMessage(k)); return; }

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
});
