// Server-side mirror of app/src/game/xp.ts (streak bonus omitted: the server would read the
// streak from its own records). In production, share one package between client and server.
function computeSessionXp({ exercises, firstCompletion }) {
  const lines = [];
  if (!exercises.length) return { lines, total: 0 };
  lines.push({ label: 'Session complete', xp: 10 });
  const avg = exercises.reduce((a, e) => a + e.accuracy, 0) / exercises.length;
  const accuracyXp = Math.round(avg * 10);
  if (accuracyXp > 0) lines.push({ label: `Accuracy ${Math.round(avg * 100)}%`, xp: accuracyXp });
  if (exercises.every((e) => e.stars === 3)) lines.push({ label: 'Flawless', xp: 5 });
  if (firstCompletion) lines.push({ label: 'New lesson', xp: 5 });
  return { lines, total: lines.reduce((a, l) => a + l.xp, 0) };
}

module.exports = { computeSessionXp };
