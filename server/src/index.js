#!/usr/bin/env node
/**
 * Soloist mock API — zero dependencies (node:http), so `npm start` works with no install.
 *
 *   GET  /v1/health
 *   GET  /v1/course                   skills + lessons in one call
 *   GET  /v1/skill-tree
 *   GET  /v1/lessons/:id
 *   GET  /v1/charts/:id?speed=75      speed variants (50–100 %) rendered lazily
 *   GET  /v1/songs/:id/manifest?speed=75   isolated stems + sha256 for content-addressed caching
 *   GET  /stems/:songId/:stem.wav      static, supports HTTP Range + ETag
 *   POST /v1/sessions                  session report; XP recomputed server-side
 *
 * Env: PORT (default 4000), LATENCY_MS (artificial delay to test loading states).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { computeSessionXp } = require('./xp');
const content = require('./content');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4000);
const LATENCY_MS = Number(process.env.LATENCY_MS || 0);
const sessions = []; // in-memory "database"

const SAFE_ID = /^[a-z0-9-]+$/;

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(payload);
}

function readJson(rel) {
  const p = path.join(ROOT, 'data', rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function serveStem(req, res, songId, file) {
  if (!SAFE_ID.test(songId) || !/^[a-z0-9-]+\.wav$/.test(file)) return send(res, 400, { error: 'bad path' });
  const p = path.join(ROOT, 'public', 'stems', songId, file);
  if (!fs.existsSync(p)) return send(res, 404, { error: 'stem not found' });
  const stat = fs.statSync(p);
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  const base = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base);
    return res.end();
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': stat.size });
  fs.createReadStream(p).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }
  if (LATENCY_MS) await new Promise((r) => setTimeout(r, LATENCY_MS));

  if (req.method === 'GET') {
    if (url.pathname === '/v1/health') return send(res, 200, { ok: true, sessions: sessions.length });
    if (url.pathname === '/v1/skill-tree') return send(res, 200, readJson('skill-tree.json'));
    if (url.pathname === '/v1/course') {
      const lessons = content.LESSONS.map((l) => readJson(`lessons/${l.id}.json`)).filter(Boolean);
      return send(res, 200, { ...readJson('skill-tree.json'), lessons });
    }
    if (parts[0] === 'v1' && parts.length === 3 && parts[1] === 'lessons') {
      if (!SAFE_ID.test(parts[2])) return send(res, 400, { error: 'bad id' });
      const doc = readJson(`lessons/${parts[2]}.json`);
      return doc ? send(res, 200, doc) : send(res, 404, { error: 'lesson not found' });
    }
    const isChart = parts[0] === 'v1' && parts.length === 3 && parts[1] === 'charts';
    const isManifest = parts[0] === 'v1' && parts[1] === 'songs' && parts[3] === 'manifest';
    if (isChart || isManifest) {
      if (!SAFE_ID.test(parts[2])) return send(res, 400, { error: 'bad id' });
      const speed = Number(url.searchParams.get('speed') || 100);
      let id = parts[2];
      if (speed !== 100) {
        id = content.ensureVariant(parts[2], speed);
        if (!id) return send(res, 400, { error: `speed must be one of ${content.SPEEDS.join(', ')}` });
      }
      const doc = readJson(`${isChart ? 'charts' : 'songs'}/${id}.json`);
      return doc ? send(res, 200, doc) : send(res, 404, { error: `${isChart ? 'chart' : 'song'} not found` });
    }
    if (parts[0] === 'stems' && parts.length === 3) return serveStem(req, res, parts[1], parts[2]);
  }

  if (req.method === 'POST' && url.pathname === '/v1/sessions') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }
    if (!body || typeof body.lessonId !== 'string' || !Array.isArray(body.results)) {
      return send(res, 422, { error: 'lessonId and results[] required' });
    }
    // Never trust client XP: recompute from the graded summaries.
    const outcomes = body.results.map((r) => ({
      accuracy: Math.max(0, Math.min(1, Number(r?.summary?.accuracy) || 0)),
      stars: Math.max(0, Math.min(3, Number(r?.summary?.stars) || 0)),
      passed: Boolean(r?.summary?.passed),
    }));
    const firstCompletion = !sessions.some((s) => s.lessonId === body.lessonId);
    const serverXp = computeSessionXp({ exercises: outcomes, firstCompletion, streakDays: 0 });
    const record = { id: sessions.length + 1, lessonId: body.lessonId, at: body.at, activeMs: body.activeMs, serverXp: serverXp.total, clientXp: body.clientXp };
    sessions.push(record);
    const mismatch = typeof body.clientXp === 'number' && Math.abs(body.clientXp - serverXp.total) > 5;
    return send(res, 201, { accepted: true, id: record.id, serverXp: serverXp.total, flagged: mismatch });
  }

  send(res, 404, { error: 'not found' });
}

// (Re)generate content when missing or when the course spec changed.
const specStamp = path.join(ROOT, 'data', '.spec-mtime');
const specMtime = String(fs.statSync(path.join(__dirname, 'content.js')).mtimeMs);
if (!fs.existsSync(path.join(ROOT, 'data', 'skill-tree.json')) || (fs.existsSync(specStamp) ? fs.readFileSync(specStamp, 'utf8') : '') !== specMtime) {
  console.log('Generating course content...');
  content.generateAll();
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  handle(req, res)
    .catch((e) => send(res, 500, { error: e.message }))
    .finally(() => console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`));
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const addrs = Object.values(require('node:os').networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `http://${a.address}:${PORT}`);
    console.log(`\nSoloist mock API is running.`);
    console.log(`  On this computer:   http://localhost:${PORT}`);
    for (const a of addrs) console.log(`  From your phone:    ${a}   <- type this into Soloist > Settings > Server`);
    console.log('');
  });
}
module.exports = { server };
