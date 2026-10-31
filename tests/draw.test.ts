import { describe, expect, it } from 'vitest';
import {
  DrawImpossibleError,
  MIN_PARTICIPANTS,
  drawAssignment,
  hasValidAssignment,
  isAllowed,
  isValidAssignment,
  secureRandomInt,
  type DrawInput,
} from '../supabase/functions/_shared/draw';

const makeIds = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

/** Random preferences (each person may or may not set either one; never self). */
function randomPrefs(ids: string[], probability = 0.5): DrawInput {
  const noGiveTo: DrawInput['noGiveTo'] = {};
  const noReceiveFrom: DrawInput['noReceiveFrom'] = {};
  for (const id of ids) {
    const others = ids.filter((x) => x !== id);
    if (Math.random() < probability) noGiveTo[id] = others[Math.floor(Math.random() * others.length)];
    if (Math.random() < probability) noReceiveFrom[id] = others[Math.floor(Math.random() * others.length)];
  }
  return { ids, noGiveTo, noReceiveFrom };
}

function* permutations(arr: string[]): Generator<string[]> {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function bruteForceValid(input: DrawInput): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  for (const p of permutations(input.ids)) {
    const m = new Map(input.ids.map((g, i) => [g, p[i]] as [string, string]));
    if (isValidAssignment(m, input)) out.push(m);
  }
  return out;
}

const key = (m: Map<string, string>) => [...m].map(([g, r]) => `${g}>${r}`).sort().join(',');

describe('secureRandomInt', () => {
  it('stays in range', () => {
    for (let i = 0; i < 10_000; i++) {
      const x = secureRandomInt(7);
      expect(Number.isInteger(x) && x >= 0 && x < 7).toBe(true);
    }
    expect(secureRandomInt(1)).toBe(0);
  });
  it('rejects bad bounds', () => {
    expect(() => secureRandomInt(0)).toThrow();
    expect(() => secureRandomInt(1.5)).toThrow();
  });
});

describe('isAllowed / isValidAssignment', () => {
  const input: DrawInput = { ids: ['a', 'b', 'c', 'd'], noGiveTo: { a: 'b' }, noReceiveFrom: { c: 'd' } };
  it('pairwise rules', () => {
    expect(isAllowed('a', 'a', input)).toBe(false);
    expect(isAllowed('a', 'b', input)).toBe(false);
    expect(isAllowed('d', 'c', input)).toBe(false);
    expect(isAllowed('a', 'c', input)).toBe(true);
  });
  it('rejects swaps and non-permutations', () => {
    const swap = new Map([['a', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'b']]);
    expect(isValidAssignment(swap, input)).toBe(false);
    const dup = new Map([['a', 'c'], ['b', 'c'], ['c', 'd'], ['d', 'a']]);
    expect(isValidAssignment(dup, input)).toBe(false);
    const ok = new Map([['a', 'c'], ['c', 'b'], ['b', 'd'], ['d', 'a']]);
    expect(isValidAssignment(ok, input)).toBe(true);
  });
});

describe('drawAssignment validity', () => {
  it('always returns a valid assignment for N = 4..15 with random preferences', () => {
    for (let n = 4; n <= 15; n++) {
      const ids = makeIds(n);
      let checked = 0;
      for (let round = 0; round < 40; round++) {
        const input = randomPrefs(ids);
        if (!hasValidAssignment(input)) {
          expect(() => drawAssignment(input)).toThrow(DrawImpossibleError);
          continue;
        }
        for (let k = 0; k < 5; k++) {
          const a = drawAssignment(input);
          expect(isValidAssignment(a, input)).toBe(true);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('works without any preferences', () => {
    for (let n = 4; n <= 15; n++) {
      const input: DrawInput = { ids: makeIds(n), noGiveTo: {}, noReceiveFrom: {} };
      for (let k = 0; k < 20; k++) expect(isValidAssignment(drawAssignment(input), input)).toBe(true);
    }
  });
});

describe('impossible draws', () => {
  it('N < 4 throws (with 3 people the draw would be guessable)', () => {
    expect(() => drawAssignment({ ids: [], noGiveTo: {}, noReceiveFrom: {} })).toThrow(DrawImpossibleError);
    expect(() => drawAssignment({ ids: ['a'], noGiveTo: {}, noReceiveFrom: {} })).toThrow(DrawImpossibleError);
    expect(() => drawAssignment({ ids: ['a', 'b'], noGiveTo: {}, noReceiveFrom: {} })).toThrow(DrawImpossibleError);
    expect(() => drawAssignment({ ids: ['a', 'b', 'c'], noGiveTo: {}, noReceiveFrom: {} })).toThrow(DrawImpossibleError);
  });

  it('N = 4 where preferences leave someone with nobody to gift throws', () => {
    // a can't gift b (own choice), c or d (their choices) → no valid assignment.
    const input: DrawInput = { ids: ['a', 'b', 'c', 'd'], noGiveTo: { a: 'b' }, noReceiveFrom: { c: 'a', d: 'a' } };
    expect(hasValidAssignment(input)).toBe(false);
    expect(() => drawAssignment(input)).toThrow(DrawImpossibleError);
  });

  it('rejects duplicate ids', () => {
    expect(() => drawAssignment({ ids: ['a', 'a', 'b'], noGiveTo: {}, noReceiveFrom: {} })).toThrow();
  });
});

describe('uniformity', () => {
  it('N = 4: the 6 valid assignments (4-cycles) each appear ~1/6 of the time', () => {
    const input: DrawInput = { ids: ['a', 'b', 'c', 'd'], noGiveTo: {}, noReceiveFrom: {} };
    const valid = bruteForceValid(input);
    expect(valid.length).toBe(6);
    const counts = new Map<string, number>(valid.map((m) => [key(m), 0]));
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const k = key(drawAssignment(input));
      expect(counts.has(k)).toBe(true);
      counts.set(k, counts.get(k)! + 1);
    }
    for (const c of counts.values()) {
      expect(c).toBeGreaterThanOrEqual(9_500);
      expect(c).toBeLessThanOrEqual(10_500);
    }
  });

  it('uniform with preferences too (N = 5, compared to brute force)', () => {
    const input: DrawInput = { ids: ['a', 'b', 'c', 'd', 'e'], noGiveTo: { a: 'b' }, noReceiveFrom: { d: 'c' } };
    const valid = bruteForceValid(input);
    expect(valid.length).toBeGreaterThan(1);
    const counts = new Map<string, number>(valid.map((m) => [key(m), 0]));
    const perOutcome = 3_000;
    const draws = perOutcome * valid.length;
    for (let i = 0; i < draws; i++) {
      const k = key(drawAssignment(input));
      expect(counts.has(k)).toBe(true);
      counts.set(k, counts.get(k)! + 1);
    }
    for (const c of counts.values()) {
      expect(c).toBeGreaterThanOrEqual(perOutcome * 0.88);
      expect(c).toBeLessThanOrEqual(perOutcome * 1.12);
    }
  });
});

describe('performance', () => {
  it('N = 12 with preferences: 50 draws in < 1 s', () => {
    const ids = makeIds(12);
    const noGiveTo: DrawInput['noGiveTo'] = {};
    const noReceiveFrom: DrawInput['noReceiveFrom'] = {};
    ids.forEach((id, i) => {
      noGiveTo[id] = ids[(i + 1) % 12];
      noReceiveFrom[id] = ids[(i + 3) % 12];
    });
    const input: DrawInput = { ids, noGiveTo, noReceiveFrom };
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) expect(isValidAssignment(drawAssignment(input), input)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('hasValidAssignment', () => {
  it('agrees with brute force for small N', () => {
    for (let n = 1; n <= 6; n++) {
      const ids = makeIds(n);
      for (let round = 0; round < 60; round++) {
        const input = randomPrefs(ids, 0.8);
        expect(hasValidAssignment(input)).toBe(n >= MIN_PARTICIPANTS && bruteForceValid(input).length > 0);
      }
    }
  });
});

describe('fallback', () => {
  it('uses randomized backtracking when rejection sampling never succeeds', () => {
    const input: DrawInput = { ids: makeIds(5), noGiveTo: {}, noReceiveFrom: {} };
    // A "random" source returning n - 1 makes Fisher–Yates produce the identity
    // permutation every time (never valid) -> fallback path.
    const a = drawAssignment(input, (n) => n - 1);
    expect(isValidAssignment(a, input)).toBe(true);
  });
});
