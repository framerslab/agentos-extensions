// The fake product of the lifecycle test, on :8790 (PRODUCT_PORT): the report url the scheduler forwards each run's
// reports to. It keeps every report in memory with the SHA-256 of the bearer token it came under, so the test can check
// each report against its run's token without the token itself being kept, and serves them to the test.
//
//   POST /events            one ReportPost under Authorization: Bearer <run token>; 204, or 400 for a body that is no report
//   GET  /reports?runId=x   the reports, in the order they came, for one run or for all
//   GET  /health            200
//
// It logs one line at start and nothing else: a chat report holds what someone typed.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PRODUCT_PORT ?? 8790);
const MAX_BODY_BYTES = 256 * 1024;
const reports = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString('utf8') : undefined));
    req.on('error', () => resolve(undefined));
  });
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://product');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/reports') {
    const runId = url.searchParams.get('runId');
    return send(res, 200, runId ? reports.filter((r) => r.runId === runId) : reports);
  }
  if (req.method === 'POST' && url.pathname === '/events') {
    const text = await readBody(req);
    let report;
    try {
      report = text === undefined ? undefined : JSON.parse(text);
    } catch {
      report = undefined;
    }
    if (!report || typeof report.runId !== 'string' || typeof report.event !== 'string' || typeof report.seq !== 'number' || typeof report.at !== 'number') {
      return send(res, 400, { error: 'not a report' });
    }
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    reports.push({
      runId: report.runId,
      workerId: report.workerId,
      seq: report.seq,
      event: report.event,
      at: report.at,
      data: report.data,
      receivedAt: Date.now(),
      bearerSha256: bearer ? createHash('sha256').update(bearer).digest('hex') : null,
    });
    return send(res, 204);
  }
  send(res, 404, { error: 'no such route' });
}

createServer((req, res) => {
  route(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, '0.0.0.0', () => console.log(`fake product listening on ${PORT}`));
