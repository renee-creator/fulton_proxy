const http = require('http');
const https = require('https');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'Bad JSON'})); return; }

    const anthropicBody = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: parsed.content }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(anthropicBody),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const apiReq = https.request(options, apiRes => {
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      apiRes.pipe(res);
    });

    apiReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    apiReq.write(anthropicBody);
    apiReq.end();
  });
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
