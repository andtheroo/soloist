#!/usr/bin/env bash
# Feeds every generated guide stem (server/public) through the C++ core as if it were the mic.
# Run `cd server && npm run generate` first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$HERE/../../../../../server"
OUT="${TMPDIR:-/tmp}/soloist_e2e"
g++ -std=c++17 -O2 -pthread -I"$HERE/.." "$HERE"/../*.cpp "$HERE/e2e_chart_test.cpp" -o "$OUT"
fail=0
for chart in "$SERVER"/data/charts/*.json; do
  id="$(basename "$chart" .json)"
  [[ "$id" == calibration || "$id" == *-s[0-9]* ]] && continue
  node -e "const c=require(process.argv[1]);console.log(c.notes.map(n=>n.timeMs+' '+n.midi).join('\n'))" "$chart" > "$OUT-$id.txt"
  "$OUT" "$SERVER/public/stems/$id/guide.wav" "$OUT-$id.txt" || fail=1
  # Distractor runs: expect the chart a semitone / whole step off -> must NOT verify.
  for t in 1 -2; do "$OUT" "$SERVER/public/stems/$id/guide.wav" "$OUT-$id.txt" $t > /dev/null || { echo "  false accepts with transpose $t"; fail=1; }; done
done
if [[ $fail == 0 ]]; then echo "ALL E2E CHART TESTS PASSED"; else echo "E2E FAILURES"; fi
exit $fail
