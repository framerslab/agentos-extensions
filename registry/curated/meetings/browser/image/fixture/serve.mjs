// The fixture's server, on :8787 (FIXTURE_PORT): the meeting page and its recording, a queue of scripted events the page
// polls, and a record of what the page did. Node's own modules only, so its image needs no install.
//
//   GET  /                the page (any query: ?platform=google_meet&people=1, or ?platform=microsoft_teams&composer=self)
//   GET  /recording.wav   the known recording, with byte ranges for the <audio> element
//   POST /control         appends one event for the page: {type:'admit'}, {type:'late_joiner'}, {type:'chat', sender, text},
//                         {type:'chat', sender, text, noId: true} (a Meet message without data-message-id),
//                         {type:'leave_all'}, {type:'hide_chat'}, {type:'show_chat'}
//   GET  /events          what the page polls: the queued events, which it drains
//   POST /joined, /posted (the text as the body), /left   what the page reports
//   GET  /state           {joined, posted, left}: the knocks, the texts the bot posted in order, the presses of Leave
//   POST /reset           empties the queue and the record, between runs
//   GET  /health          200
//
// It logs one line at start and nothing else: a posted text is a meeting's content even here.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FIXTURE_PORT ?? 8787);
const PAGE = readFileSync(join(here, 'index.html'));
const RECORDING = join(here, 'recording.wav');
const RECORDING_BYTES = statSync(RECORDING).size;
const EVENT_TYPES = new Set(['admit', 'late_joiner', 'chat', 'leave_all', 'hide_chat', 'show_chat']);
const MAX_BODY_BYTES = 64 * 1024;

let queue = [];
let record = { joined: 0, posted: [], left: 0 };

/** The request's body as text, or undefined when it is over the limit or the request fails. */
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

/** The recording, whole or by one byte range (`bytes=a-b`, `bytes=a-`, `bytes=-n`), as a media element asks for it. */
function sendRecording(req, res) {
  const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = RECORDING_BYTES - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(0, RECORDING_BYTES - Number(range[2]));
    }
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${RECORDING_BYTES}` });
      res.end();
      return;
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${RECORDING_BYTES}`;
  }
  headers['content-length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(RECORDING, { start, end }).pipe(res);
}

async function route(req, res) {
  const { pathname } = new URL(req.url ?? '/', 'http://fixture');
  const method = req.method ?? 'GET';
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && pathname === '/recording.wav') return sendRecording(req, res);
  if (method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
  if (method === 'GET' && pathname === '/events') {
    const drained = queue;
    queue = [];
    return send(res, 200, drained);
  }
  if (method === 'GET' && pathname === '/state') return send(res, 200, record);
  if (method !== 'POST') return send(res, 404, { error: 'no such route' });
  const body = await readBody(req);
  if (body === undefined) return send(res, 413, { error: 'body too large' });
  if (pathname === '/control') {
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return send(res, 400, { error: 'not JSON' });
    }
    if (!event || !EVENT_TYPES.has(event.type)) return send(res, 400, { error: 'unknown event' });
    queue.push({ type: event.type, sender: typeof event.sender === 'string' ? event.sender : undefined, text: typeof event.text === 'string' ? event.text : undefined, noId: event.noId === true || undefined });
    return send(res, 204);
  }
  if (pathname === '/reset') {
    queue = [];
    record = { joined: 0, posted: [], left: 0 };
    return send(res, 204);
  }
  if (pathname === '/joined') {
    record.joined += 1;
    return send(res, 204);
  }
  if (pathname === '/posted') {
    record.posted.push(body);
    return send(res, 204);
  }
  if (pathname === '/left') {
    record.left += 1;
    return send(res, 204);
  }
  send(res, 404, { error: 'no such route' });
}

createServer((req, res) => {
  route(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, '0.0.0.0', () => console.log(`fixture listening on ${PORT}`));
