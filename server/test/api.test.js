const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { server } = require('../src/index');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const getJson = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};

test('skill tree references existing lessons, charts and songs', async () => {
  const { body } = await getJson('/v1/skill-tree');
  assert.strictEqual(body.skills.length, 8);
  for (const s of body.skills) {
    for (const lid of s.lessonIds) {
      const lesson = await getJson(`/v1/lessons/${lid}`);
      assert.strictEqual(lesson.status, 200, lid);
      assert.strictEqual(lesson.body.budgetMs, 180000);
      for (const ex of lesson.body.exercises) {
        const chart = await getJson(`/v1/charts/${ex.chartId}`);
        assert.strictEqual(chart.status, 200);
        const times = chart.body.notes.map((n) => n.timeMs);
        assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), 'notes sorted');
        const manifest = await getJson(`/v1/songs/${ex.songId}/manifest`);
        assert.deepStrictEqual(manifest.body.stems.map((x) => x.id).sort(), ['bass', 'click', 'guide']);
      }
    }
  }
});

test('course endpoint returns 8 skills and every lesson', async () => {
  const { body } = await getJson('/v1/course');
  assert.strictEqual(body.skills.length, 8);
  const lessonIds = body.skills.flatMap((s) => s.lessonIds).sort();
  assert.deepStrictEqual(body.lessons.map((l) => l.id).sort(), lessonIds);
  assert.ok(body.lessons.length >= 20);
});

test('speed variants are rendered lazily and scale time', async () => {
  const full = await getJson('/v1/charts/pent-up');
  const slow = await getJson('/v1/charts/pent-up?speed=75');
  assert.strictEqual(slow.status, 200);
  assert.strictEqual(slow.body.speed, 75);
  assert.strictEqual(slow.body.notes.length, full.body.notes.length);
  const ratio = slow.body.notes[5].timeMs / full.body.notes[5].timeMs;
  assert.ok(Math.abs(ratio - 100 / 75) < 0.01, `ratio ${ratio}`);
  const m = await getJson('/v1/songs/pent-up/manifest?speed=75');
  assert.strictEqual(m.status, 200);
  assert.ok(m.body.stems[0].url.includes('pent-up-s75'));
  const stem = await fetch(base + m.body.stems[0].url);
  assert.strictEqual(stem.status, 200);
  assert.strictEqual((await getJson('/v1/charts/pent-up?speed=33')).status, 400);
});

test('chord notes share one timestamp so the grader treats a strum as one event', async () => {
  const { body } = await getJson('/v1/charts/chords-g-c-d');
  const first = body.notes.filter((n) => n.timeMs === body.notes[0].timeMs);
  assert.strictEqual(first.length, 6); // G chord
});

test('stems support Range requests and ETags', async () => {
  const { body } = await getJson('/v1/songs/open-low/manifest');
  const stem = body.stems[0];
  const full = await fetch(base + stem.url);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(Number(full.headers.get('content-length')), stem.bytes);
  const buf = Buffer.from(await full.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 4).toString(), 'RIFF');

  const part = await fetch(base + stem.url, { headers: { Range: 'bytes=0-43' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual((await part.arrayBuffer()).byteLength, 44);

  const cached = await fetch(base + stem.url, { headers: { 'If-None-Match': full.headers.get('etag') } });
  assert.strictEqual(cached.status, 304);
});

test('rejects path traversal', async () => {
  const r = await fetch(base + '/stems/..%2F..%2Fsrc/index.js');
  assert.notStrictEqual(r.status, 200);
  const c = await getJson('/v1/charts/..%2Fskill-tree');
  assert.strictEqual(c.status, 400);
});

test('session report recomputes XP server-side and flags tampering', async () => {
  const post = (clientXp) =>
    fetch(base + '/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: 'basics-1', clientXp, results: [{ summary: { accuracy: 1, stars: 3, passed: true } }] }),
    }).then((r) => r.json());
  const honest = await post(30);
  assert.strictEqual(honest.serverXp, 30);
  assert.strictEqual(honest.flagged, false);
  const cheat = await post(9999);
  assert.strictEqual(cheat.flagged, true);
});
