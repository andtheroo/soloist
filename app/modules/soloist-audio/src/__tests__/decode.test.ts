import { decodeSnapshot } from '../decode';
import { Poll } from '../SoloistAudio.types';

describe('decodeSnapshot', () => {
  it('decodes header and variable-length events (mirrors AudioCore::pollState)', () => {
    const header = [1234.5, 99999, 1, 0, -30, 60000, 0, 2, 110.2, 0.95, 3, 2];
    expect(header).toHaveLength(Poll.HEADER);
    const ev1 = [1000, 64.1, 0.9, -18, 99990, 2, 7, 8]; // two verified notes
    const ev2 = [1250, -1, 0, -25, 99995, 0];
    const snap = decodeSnapshot([...header, ...ev1, ...ev2]);
    expect(snap.songMs).toBe(1234.5);
    expect(snap.playing).toBe(true);
    expect(snap.deviceGeneration).toBe(2);
    expect(snap.tunerHz).toBe(110.2);
    expect(snap.loopCount).toBe(3);
    expect(snap.events).toHaveLength(2);
    expect(snap.events[0].verified).toEqual([7, 8]);
    expect(snap.events[1]).toMatchObject({ songMs: 1250, midi: -1, verified: [] });
  });

  it('tolerates an empty array (engine not started)', () => {
    const snap = decodeSnapshot([]);
    expect(snap.events).toEqual([]);
    expect(snap.playing).toBe(false);
  });
});
