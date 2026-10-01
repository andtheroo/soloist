/**
 * The whole course in one place: skills -> lessons -> exercises -> charts -> stems.
 * Charts and audio are both generated from this spec, so they can never disagree.
 *
 * All material is original exercise material or public-domain melodies
 * (Twinkle Twinkle, Ode to Joy, When the Saints).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SR = 24000; // stems are rendered at 24 kHz mono; the app resamples to the device rate
const TUNING = [64, 59, 55, 50, 45, 40]; // string 1 (high E) .. string 6 (low E)
const SPEEDS = [50, 60, 75, 80, 90, 100];

// ----------------------------------------------------------------------------- notation
// A step is one of:
//   [string, fret, beats]                 single note
//   ['r', beats]                          rest
//   { chord: CHORDS.Em | [[s,f],...], beats }   strummed chord (chart times identical;
//                                               the synthesized guide spreads the strum)
const CHORDS = {
  Em: [[6, 0], [5, 2], [4, 2], [3, 0], [2, 0], [1, 0]],
  Am: [[5, 0], [4, 2], [3, 2], [2, 1], [1, 0]],
  G: [[6, 3], [5, 2], [4, 0], [3, 0], [2, 0], [1, 3]],
  C: [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0]],
  D: [[4, 0], [3, 2], [2, 3], [1, 2]],
  E5: [[6, 0], [5, 2]],
  A5: [[5, 0], [4, 2]],
  D5: [[4, 0], [3, 2]],
  G5: [[6, 3], [5, 5]],
  C5: [[5, 3], [4, 5]],
};
const ch = (name, beats) => ({ chord: CHORDS[name], beats, name });
const rep = (n, arr) => Array.from({ length: n }, () => arr).flat();
const rest = (beats) => ['r', beats];

/** Map MIDI pitches to first-position tab (lowest fret, thinner string on ties). */
function melody(pairs) {
  return pairs.map(([midi, beats]) => {
    if (midi === null) return rest(beats);
    let best = null;
    for (let s = 1; s <= 6; s++) {
      const fret = midi - TUNING[s - 1];
      if (fret < 0 || fret > 5) continue;
      if (!best || fret < best[1]) best = [s, fret];
    }
    if (!best) throw new Error(`midi ${midi} not playable in first position`);
    return [best[0], best[1], beats];
  });
}
const N = { G3: 55, A3: 57, B3: 59, C4: 60, D4: 62, E4: 64, F4: 65, G4: 67 };

const PENT = [[6, 0], [6, 3], [5, 0], [5, 2], [4, 0], [4, 2], [3, 0], [3, 2], [2, 0], [2, 3], [1, 0], [1, 3]];
const spider = (s) => [[s, 1, 1], [s, 2, 1], [s, 3, 1], [s, 4, 1]];

// ----------------------------------------------------------------------------- songs
const SONGS = {
  // Open strings
  'open-low': { title: 'Low strings: E A D', bpm: 76, steps: rep(4, [[6, 0, 1], [5, 0, 1], [4, 0, 1], [5, 0, 1]]), roots: [40, 45] },
  'open-high': { title: 'High strings: G B E', bpm: 76, steps: rep(4, [[3, 0, 1], [2, 0, 1], [1, 0, 1], [2, 0, 1]]), roots: [43, 47] },
  'open-all': { title: 'All six strings', bpm: 80, steps: rep(2, [[6, 0, 1], [5, 0, 1], [4, 0, 1], [3, 0, 1], [2, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 1]]), roots: [40, 43] },
  'open-skip': { title: 'String skipping', bpm: 80, steps: rep(4, [[6, 0, 1], [4, 0, 1], [5, 0, 1], [3, 0, 1]]), roots: [40, 45] },

  // First frets
  'spider-low': { title: 'Spider walk: low strings', bpm: 70, steps: rep(2, [...spider(6), ...spider(5)]), roots: [40] },
  'spider-all': { title: 'Spider walk: all strings', bpm: 72, steps: [6, 5, 4, 3, 2, 1].flatMap(spider), roots: [40, 45] },
  'spider-down': { title: 'Spider walk: descending', bpm: 72, steps: [1, 2, 3, 4, 5, 6].flatMap((s) => spider(s).reverse()), roots: [40, 45] },

  // Rhythm
  'rhythm-quarters': { title: 'Quarter notes & rests', bpm: 80, steps: rep(4, [[6, 0, 1], [6, 0, 1], rest(1), [5, 0, 1]]), roots: [40, 45] },
  'rhythm-eighths': { title: 'Eighth notes', bpm: 84, steps: rep(4, [[6, 0, 0.5], [6, 0, 0.5], [5, 0, 0.5], [5, 0, 0.5], [4, 0, 0.5], [4, 0, 0.5], [5, 0, 0.5], [5, 0, 0.5]]), roots: [40] },
  'rhythm-offbeat': { title: 'Off-beat pushes', bpm: 84, steps: rep(4, [[6, 0, 1], rest(0.5), [6, 0, 1], [5, 0, 0.5], rest(0.5), [4, 0, 0.5]]), roots: [40, 45] },

  // Power chords
  'power-e-a-d': { title: 'E5 · A5 · D5', bpm: 84, steps: rep(2, [ch('E5', 2), ch('A5', 2), ch('D5', 2), ch('A5', 2)]), roots: [40, 45, 50, 45] },
  'power-moving': { title: 'Moving shapes: G5 · C5', bpm: 84, steps: rep(2, [ch('E5', 2), ch('G5', 2), ch('A5', 2), ch('C5', 2)]), roots: [40, 43, 45, 48] },
  'power-chug': { title: 'Eighth-note chug', bpm: 96, steps: rep(2, [...rep(6, [ch('E5', 0.5)]), ch('G5', 0.5), ch('A5', 0.5), ...rep(6, [ch('E5', 0.5)]), ch('D5', 0.5), ch('C5', 0.5)]), roots: [40] },

  // Minor pentatonic
  'pent-up': { title: 'E minor pentatonic ↑', bpm: 84, steps: rep(2, [...PENT.slice(0, 11).map(([s, f]) => [s, f, 0.5]), [1, 3, 1.5]]), roots: [40] },
  'pent-down': { title: 'E minor pentatonic ↓', bpm: 84, steps: rep(2, [...[...PENT].reverse().slice(0, 11).map(([s, f]) => [s, f, 0.5]), [6, 0, 1.5]]), roots: [40] },
  'pent-threes': { title: 'Groups of three', bpm: 80, steps: [...Array.from({ length: 10 }, (_, i) => PENT.slice(i, i + 3)).flat().map(([s, f]) => [s, f, 0.5]), [1, 3, 1]], roots: [40] },

  // Open chords
  'chords-em-am': { title: 'Em ↔ Am', bpm: 72, steps: rep(2, [ch('Em', 2), ch('Em', 2), ch('Am', 2), ch('Am', 2)]), roots: [40, 40, 45, 45] },
  'chords-g-c-d': { title: 'G · C · D', bpm: 72, steps: rep(2, [ch('G', 2), ch('G', 2), ch('C', 2), ch('D', 2)]), roots: [43, 43, 48, 50] },
  'chords-changes': { title: 'Em · C · G · D', bpm: 76, steps: rep(2, [ch('Em', 1), ch('Em', 1), ch('C', 1), ch('C', 1), ch('G', 1), ch('G', 1), ch('D', 1), ch('D', 1)]), roots: [40, 48, 43, 50] },

  // Public-domain melodies
  twinkle: {
    title: 'Twinkle Twinkle (trad.)', bpm: 84, roots: [43, 48, 43, 50],
    steps: melody([[N.G3, 1], [N.G3, 1], [N.D4, 1], [N.D4, 1], [N.E4, 1], [N.E4, 1], [N.D4, 2],
      [N.C4, 1], [N.C4, 1], [N.B3, 1], [N.B3, 1], [N.A3, 1], [N.A3, 1], [N.G3, 2],
      [N.D4, 1], [N.D4, 1], [N.C4, 1], [N.C4, 1], [N.B3, 1], [N.B3, 1], [N.A3, 2],
      [N.D4, 1], [N.D4, 1], [N.C4, 1], [N.C4, 1], [N.B3, 1], [N.B3, 1], [N.A3, 2]]),
  },
  'ode-to-joy': {
    title: 'Ode to Joy (Beethoven)', bpm: 88, roots: [48, 43],
    steps: melody([[N.E4, 1], [N.E4, 1], [N.F4, 1], [N.G4, 1], [N.G4, 1], [N.F4, 1], [N.E4, 1], [N.D4, 1],
      [N.C4, 1], [N.C4, 1], [N.D4, 1], [N.E4, 1], [N.E4, 1.5], [N.D4, 0.5], [N.D4, 2],
      [N.E4, 1], [N.E4, 1], [N.F4, 1], [N.G4, 1], [N.G4, 1], [N.F4, 1], [N.E4, 1], [N.D4, 1],
      [N.C4, 1], [N.C4, 1], [N.D4, 1], [N.E4, 1], [N.D4, 1.5], [N.C4, 0.5], [N.C4, 2]]),
  },
  saints: {
    title: 'When the Saints (trad.)', bpm: 96, roots: [48, 48, 43, 48],
    steps: melody([[N.C4, 1], [N.E4, 1], [N.F4, 1], [N.G4, 4], [null, 1], [N.C4, 1], [N.E4, 1], [N.F4, 1], [N.G4, 4], [null, 1],
      [N.C4, 1], [N.E4, 1], [N.F4, 1], [N.G4, 2], [N.E4, 2], [N.C4, 2], [N.E4, 2], [N.D4, 4],
      [null, 1], [N.E4, 1], [N.E4, 1], [N.D4, 1], [N.C4, 3], [N.C4, 1], [N.E4, 2], [N.G4, 1], [N.G4, 1], [N.F4, 3]]),
  },

  // Soloing (original licks in E minor pentatonic)
  'lick-1': { title: 'Lick 1: the climb', bpm: 84, steps: rep(2, [[4, 0, 0.5], [4, 2, 0.5], [3, 0, 0.5], [3, 2, 0.5], [2, 0, 1], [2, 3, 0.5], [2, 0, 0.5], [3, 2, 2], rest(2)]), roots: [40] },
  'lick-2': { title: 'Lick 2: call & response', bpm: 88, steps: rep(2, [[1, 3, 0.5], [1, 0, 0.5], [2, 3, 1], [2, 0, 2], rest(0.5), [3, 2, 0.5], [3, 0, 0.5], [4, 2, 0.5], [4, 0, 1], [6, 3, 0.5], [6, 0, 2.5]]), roots: [40, 45] },
  'first-solo': {
    title: 'Your first 8-bar solo', bpm: 88, roots: [40, 40, 45, 40, 43, 45, 40, 40],
    steps: [[3, 0, 0.5], [3, 2, 0.5], [2, 0, 1], [2, 3, 1], [2, 0, 1], [3, 2, 2], [3, 0, 2],
      [4, 0, 0.5], [4, 2, 0.5], [3, 0, 0.5], [3, 2, 0.5], [2, 0, 2], [2, 3, 0.5], [2, 0, 0.5], [3, 2, 3],
      [1, 0, 1], [1, 3, 1], [1, 0, 0.5], [2, 3, 0.5], [2, 0, 1], [3, 2, 1], [3, 0, 1], [4, 2, 2],
      [4, 0, 0.5], [5, 2, 0.5], [5, 0, 0.5], [6, 3, 0.5], [6, 0, 6]],
  },
};

// ----------------------------------------------------------------------------- course
const SKILLS = [
  { id: 'basics', title: 'Open Strings', icon: '🎸', prerequisites: [], lessonIds: ['basics-1', 'basics-2', 'basics-3'], maxLevel: 3,
    description: 'Hold the pick, find the strings, play in time with the click.' },
  { id: 'fretting', title: 'First Frets', icon: '🖐️', prerequisites: ['basics'], lessonIds: ['fret-1', 'fret-2', 'fret-3'], maxLevel: 3,
    description: 'One finger per fret. Builds strength and accuracy.' },
  { id: 'rhythm', title: 'Rhythm', icon: '🥁', prerequisites: ['basics'], lessonIds: ['rhythm-1', 'rhythm-2', 'rhythm-3'], maxLevel: 3,
    description: 'Quarters, eighths and rests: lock in with the beat.' },
  { id: 'power', title: 'Power Chords', icon: '⚡', prerequisites: ['fretting'], lessonIds: ['power-1', 'power-2', 'power-3'], maxLevel: 3,
    description: 'Two-note chords that drive rock music.' },
  { id: 'pentatonic', title: 'Pentatonic', icon: '🪜', prerequisites: ['fretting'], lessonIds: ['pent-1', 'pent-2', 'pent-3'], maxLevel: 3,
    description: 'The five-note scale behind most guitar solos.' },
  { id: 'chords', title: 'Open Chords', icon: '🎶', prerequisites: ['fretting', 'rhythm'], lessonIds: ['chords-1', 'chords-2', 'chords-3'], maxLevel: 3,
    description: 'Strum your first full chords and change between them.' },
  { id: 'melodies', title: 'Melodies', icon: '🎼', prerequisites: ['fretting', 'rhythm'], lessonIds: ['mel-1', 'mel-2', 'mel-3'], maxLevel: 3,
    description: 'Play tunes you already know.' },
  { id: 'solo', title: 'First Solo', icon: '🌟', prerequisites: ['pentatonic', 'power'], lessonIds: ['solo-1', 'solo-2', 'solo-3'], maxLevel: 3,
    description: 'Licks, phrasing and an 8-bar solo of your own.' },
];

const ex = (songId, tip) => ({ id: `${songId}`, title: SONGS[songId].title, chartId: songId, songId, ...(tip ? { tip } : {}) });

const LESSONS = [
  { id: 'basics-1', skillId: 'basics', title: 'Meet the low strings', exercises: [ex('open-low', 'Rest your picking hand on the bridge and pick down on every note.'), ex('open-skip')] },
  { id: 'basics-2', skillId: 'basics', title: 'Meet the high strings', exercises: [ex('open-high', 'Small motions: the pick only needs to travel a few millimetres.'), ex('open-low')] },
  { id: 'basics-3', skillId: 'basics', title: 'All six', exercises: [ex('open-all', 'Keep your eyes on the highway, not your hand.'), ex('open-skip')] },
  { id: 'fret-1', skillId: 'fretting', title: 'Spider walk', exercises: [ex('spider-low', 'Press just behind the fret wire, not on top of it.')] },
  { id: 'fret-2', skillId: 'fretting', title: 'Across the neck', exercises: [ex('spider-all', 'Leave each finger down until you need it.'), ex('spider-low')] },
  { id: 'fret-3', skillId: 'fretting', title: 'Walk it back', exercises: [ex('spider-down'), ex('spider-all')] },
  { id: 'rhythm-1', skillId: 'rhythm', title: 'Counting quarters', exercises: [ex('rhythm-quarters', 'Count “1 2 3 4” out loud. Rests are notes you don’t play.')] },
  { id: 'rhythm-2', skillId: 'rhythm', title: 'Eighth notes', exercises: [ex('rhythm-eighths', 'Alternate pick: down on the beat, up in between.'), ex('rhythm-quarters')] },
  { id: 'rhythm-3', skillId: 'rhythm', title: 'Off-beats', exercises: [ex('rhythm-offbeat', 'Keep your hand moving even when you don’t hit the string.'), ex('rhythm-eighths')] },
  { id: 'power-1', skillId: 'power', title: 'Power moves', exercises: [ex('power-e-a-d', 'Mute strings you aren’t playing with your fretting hand.')] },
  { id: 'power-2', skillId: 'power', title: 'Slide the shape', exercises: [ex('power-moving', 'Keep the shape locked; move your whole hand.'), ex('power-e-a-d')] },
  { id: 'power-3', skillId: 'power', title: 'Chug', exercises: [ex('power-chug', 'Rest your palm lightly on the strings near the bridge.'), ex('power-moving')] },
  { id: 'pent-1', skillId: 'pentatonic', title: 'Box one, up', exercises: [ex('pent-up', 'One finger per fret: index on fret 2, ring on fret 3.')] },
  { id: 'pent-2', skillId: 'pentatonic', title: 'Box one, down', exercises: [ex('pent-down'), ex('pent-up')] },
  { id: 'pent-3', skillId: 'pentatonic', title: 'Groups of three', exercises: [ex('pent-threes', 'Say the pattern: 1-2-3, 2-3-4, 3-4-5…'), ex('pent-down')] },
  { id: 'chords-1', skillId: 'chords', title: 'Em and Am', exercises: [ex('chords-em-am', 'Strum down from the lowest string the chord uses.')] },
  { id: 'chords-2', skillId: 'chords', title: 'G, C and D', exercises: [ex('chords-g-c-d', 'Look at the next chord early and move on beat 4.')] },
  { id: 'chords-3', skillId: 'chords', title: 'Changes', exercises: [ex('chords-changes', 'Change on time even if the chord isn’t perfect yet.'), ex('chords-em-am')] },
  { id: 'mel-1', skillId: 'melodies', title: 'Twinkle Twinkle', exercises: [ex('twinkle', 'You know this tune: let your ear guide your fingers.')] },
  { id: 'mel-2', skillId: 'melodies', title: 'Ode to Joy', exercises: [ex('ode-to-joy')] },
  { id: 'mel-3', skillId: 'melodies', title: 'When the Saints', exercises: [ex('saints', 'Let the long notes ring for their full value.')] },
  { id: 'solo-1', skillId: 'solo', title: 'The climb', exercises: [ex('lick-1', 'Leave space: the rests are part of the lick.'), ex('pent-up')] },
  { id: 'solo-2', skillId: 'solo', title: 'Call & response', exercises: [ex('lick-2'), ex('lick-1')] },
  { id: 'solo-3', skillId: 'solo', title: 'Your first solo', exercises: [ex('first-solo', 'Play it like you mean it. Dynamics count!')] },
].map((l) => ({ ...l, budgetMs: 180000 }));

// ----------------------------------------------------------------------------- charts
const r2 = (x) => Math.round(x * 100) / 100;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function buildChart(id, song, speed = 100) {
  const bpm = (song.bpm * speed) / 100;
  const beatMs = 60000 / bpm;
  const leadInMs = 4 * beatMs; // one bar count-in, played by the click stem
  const notes = [];
  let beat = 0;
  for (const step of song.steps) {
    if (Array.isArray(step) && step[0] === 'r') {
      beat += step[1];
    } else if (Array.isArray(step)) {
      const [s, f, len] = step;
      notes.push({ timeMs: r2(leadInMs + beat * beatMs), durationMs: r2(len * beatMs * 0.9), string: s, fret: f, midi: TUNING[s - 1] + f });
      beat += len;
    } else {
      for (const [s, f] of step.chord) {
        notes.push({ timeMs: r2(leadInMs + beat * beatMs), durationMs: r2(step.beats * beatMs * 0.9), string: s, fret: f, midi: TUNING[s - 1] + f, ...(step.name ? { chord: step.name } : {}) });
      }
      beat += step.beats;
    }
  }
  notes.sort((a, b) => a.timeMs - b.timeMs || a.string - b.string);
  const totalBeats = 4 + Math.ceil(beat / 4) * 4 + 4; // count-in + whole bars + tail bar
  const beats = Array.from({ length: totalBeats }, (_, i) => ({ timeMs: r2(i * beatMs), downbeat: i % 4 === 0 }));
  return {
    id, title: song.title, bpm: r2(bpm), speed, timeSignature: [4, 4], leadInMs: r2(leadInMs),
    durationMs: r2(totalBeats * beatMs), tuning: TUNING, notes, beats,
  };
}

function buildCalibrationChart() {
  const clicks = Array.from({ length: 16 }, (_, i) => 1000 + i * 500);
  return {
    id: 'calibration', title: 'Latency check', bpm: 120, speed: 100, timeSignature: [4, 4], leadInMs: 1000,
    durationMs: 1000 + 16 * 500 + 1000, tuning: TUNING,
    notes: clicks.map((t) => ({ timeMs: t, durationMs: 50, string: 6, fret: 0, midi: 40 })),
    beats: clicks.map((t, i) => ({ timeMs: t, downbeat: i % 4 === 0 })),
  };
}

// ----------------------------------------------------------------------------- synthesis
const samplesFor = (chart) => new Float32Array(Math.ceil((chart.durationMs / 1000) * SR));

function renderClick(chart, accentAll = false) {
  const buf = samplesFor(chart);
  for (const b of chart.beats) {
    const start = Math.round((b.timeMs / 1000) * SR);
    const hz = b.downbeat || accentAll ? 1760 : 1320;
    for (let i = 0; i < 0.03 * SR && start + i < buf.length; i++) {
      buf[start + i] += 0.6 * Math.sin((2 * Math.PI * hz * i) / SR) * Math.exp(-i / (0.006 * SR));
    }
  }
  return buf;
}

function renderBass(chart, roots) {
  const buf = samplesFor(chart);
  const barMs = (60000 / chart.bpm) * 4;
  const firstBar = Math.round(chart.leadInMs / barMs);
  const lastBar = Math.floor(chart.durationMs / barMs) - 1;
  for (let bar = firstBar; bar < lastBar; bar++) {
    const hz = midiHz(roots[(bar - firstBar) % roots.length] - 12);
    const start = Math.round(((bar * barMs) / 1000) * SR);
    const len = Math.round((barMs / 1000) * SR * 0.95);
    for (let i = 0; i < len && start + i < buf.length; i++) {
      const t = i / SR;
      const env = Math.min(1, i / 100) * Math.exp(-t * 1.2);
      const ph = 2 * Math.PI * hz * t;
      buf[start + i] += 0.35 * env * (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph));
    }
  }
  return buf;
}

function renderGuide(chart) {
  // Karplus–Strong plucks; deterministic noise so re-renders are byte-identical.
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const buf = samplesFor(chart);
  // Strummed chords: spread low -> high by 6 ms per string, like a real down-strum.
  const strumIndex = new Map();
  for (const n of chart.notes) {
    const k = n.timeMs;
    const idx = strumIndex.get(k) ?? 0;
    strumIndex.set(k, idx + 1);
    const offsetMs = n.chord ? idx * 6 : 0;
    const period = Math.max(2, Math.round(SR / midiHz(n.midi)));
    const line = Float32Array.from({ length: period }, rand);
    const start = Math.round(((n.timeMs + offsetMs) / 1000) * SR);
    const len = Math.round(((n.durationMs + 120) / 1000) * SR);
    const gain = n.chord ? 0.18 : 0.3;
    for (let i = 0; i < len && start + i < buf.length; i++) {
      const k2 = i % period;
      const out = line[k2];
      line[k2] = 0.996 * 0.5 * (line[k2] + line[(k2 + 1) % period]);
      const release = i > len - 1200 ? (len - i) / 1200 : 1;
      buf[start + i] += gain * out * release;
    }
  }
  return buf;
}

function wav16(samples) {
  const data = Buffer.alloc(samples.length * 2);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const norm = peak > 0.95 ? 0.95 / peak : 1;
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * norm)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ----------------------------------------------------------------------------- variants on disk
const variantId = (songId, speed) => (speed === 100 ? songId : `${songId}-s${speed}`);

function writeVariant(songId, speed) {
  const vid = variantId(songId, speed);
  const chart = songId === 'calibration' ? buildCalibrationChart() : buildChart(songId, SONGS[songId], speed);
  const stems = songId === 'calibration'
    ? { click: { samples: renderClick(chart, true), gain: 1 } }
    : {
        click: { samples: renderClick(chart), gain: 0.5 },
        bass: { samples: renderBass(chart, SONGS[songId].roots), gain: 0.8 },
        guide: { samples: renderGuide(chart), gain: 0.9 },
      };
  const dir = path.join(ROOT, 'public', 'stems', vid);
  fs.mkdirSync(dir, { recursive: true });
  const entries = Object.entries(stems).map(([id, { samples, gain }]) => {
    const bytes = wav16(samples);
    fs.writeFileSync(path.join(dir, `${id}.wav`), bytes);
    return { id, url: `/stems/${vid}/${id}.wav`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, defaultGain: gain };
  });
  const manifest = { songId: vid, sampleRate: SR, durationMs: chart.durationMs, stems: entries };
  writeJson(`data/songs/${vid}.json`, manifest);
  writeJson(`data/charts/${vid}.json`, { ...chart, id: vid });
  return { chart, manifest };
}

/** Lazily render a speed variant the first time someone asks for it (~50–150 ms). */
function ensureVariant(songId, speed) {
  if (!(songId in SONGS) && songId !== 'calibration') return null;
  if (!SPEEDS.includes(speed)) return null;
  const vid = variantId(songId, speed);
  if (!fs.existsSync(path.join(ROOT, 'data', 'songs', `${vid}.json`))) writeVariant(songId, speed);
  return vid;
}

function writeJson(rel, obj) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function generateAll({ log = console.log } = {}) {
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'public'), { recursive: true, force: true });
  for (const id of Object.keys(SONGS)) {
    const { chart } = writeVariant(id, 100);
    log(`song ${id.padEnd(16)} ${String(chart.notes.length).padStart(3)} notes  ${(chart.durationMs / 1000).toFixed(1)} s`);
  }
  writeVariant('calibration', 100);
  writeJson('data/skill-tree.json', { skills: SKILLS });
  for (const l of LESSONS) writeJson(`data/lessons/${l.id}.json`, l);
  fs.writeFileSync(path.join(ROOT, 'data', '.spec-mtime'), String(fs.statSync(__filename).mtimeMs));
  log(`wrote ${Object.keys(SONGS).length} songs, ${SKILLS.length} skills, ${LESSONS.length} lessons`);
}

module.exports = { SONGS, SKILLS, LESSONS, SPEEDS, TUNING, SR, buildChart, ensureVariant, generateAll, variantId };
