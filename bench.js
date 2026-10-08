// One-time accuracy test. Runs only when MODEL_TEST=bench is set on Render, then logs results.
// The test material is locked in drdp-bench.enc. Only the key in DRDP_BENCH_KEY on Render can open it.
const fs = require('fs'), crypto = require('crypto'), zlib = require('zlib'), path = require('path');
function open() {
  const buf = fs.readFileSync(path.join(__dirname, 'drdp-bench.enc'));
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(String(process.env.DRDP_BENCH_KEY || '').trim(), 'hex'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(28)), d.final()])).toString('utf8'));
}
function answerLevel(text, code, ladder) {
  let t = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return { got: 'ERR', codes: [] };
  let o; try { o = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) { return { got: 'ERR', codes: [] }; }
  const ms = Array.isArray(o.measures) ? o.measures : [];
  const codes = ms.map(m => String(m.code || '').toUpperCase().replace(/\s+/g, ' ').trim());
  const m = ms[codes.indexOf(code)];
  if (!m) return { got: 'NF', codes };
  const s = ' ' + String(m.estimatedLevel || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim() + ' ';
  const named = ladder.filter(l => s.indexOf(' ' + l.toLowerCase() + ' ') >= 0);
  return { got: named.length === 1 ? named[0] : (s.trim() ? 'BAD:' + String(m.estimatedLevel).slice(0, 30) : ''), codes };
}
module.exports = function runBench(key, requestAnthropic) {
  let P;
  try { P = open(); } catch (e) { console.error('BENCH could not open the test material', e.message); return; }
  const jobs = [];
  P.cases.forEach((c, i) => { for (const cfg of ['old', 'new']) jobs.push({ i, c, cfg }); });
  let next = 0, done = 0;
  console.log('BENCH start ' + jobs.length + ' requests');
  const worker = () => {
    if (next >= jobs.length) return;
    const j = jobs[next++];
    const user = P.templates[j.c.view][j.cfg].replace('@@DOC@@', j.c.text);
    const body = { model: 'claude-haiku-5-5', max_tokens: 5000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: user }] };
    if (j.cfg === 'new') body.system = P.system[j.c.view];
    const t0 = Date.now();
    requestAnthropic(key, body, (err, status, raw) => {
      let o = {}; try { o = JSON.parse(raw || '{}'); } catch (e) {}
      const blocks = Array.isArray(o.content) ? o.content : [];
      const text = (blocks.find(b => b && b.type === 'text') || {}).text || '';
      const r = status === 200 ? answerLevel(text, j.c.code, P.ladders[j.c.view][j.c.code]) : { got: 'HTTP' + status, codes: [] };
      console.log('BENCH ' + JSON.stringify({ i: j.i, cfg: j.cfg, ms: Date.now() - t0, inp: o.usage && o.usage.input_tokens, out: o.usage && o.usage.output_tokens, stop: o.stop_reason || '', got: r.got, codes: r.codes, err: err ? String(err.message || err) : (o.error ? String(o.error.message).slice(0, 120) : '') }));
      done++;
      if (done === jobs.length) console.log('BENCH done');
      setTimeout(worker, 300);
    });
  };
  for (let k = 0; k < 4; k++) setTimeout(worker, k * 500);
};
