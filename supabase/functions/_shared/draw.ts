// Secret Santa draw algorithm.
//
// Pure module, no imports: uses only standard web APIs (crypto.getRandomValues)
// so the same file runs in the browser, in Deno (Edge Function) and in Node (vitest).
//
// Rules for giver g -> receiver r:
//   - g !== r
//   - no swaps: never g -> r together with r -> g
//   - r !== noGiveTo[g]
//   - g !== noReceiveFrom[r]
//
// The result is drawn uniformly at random among all valid assignments by
// rejection sampling of uniformly random permutations (Fisher–Yates with a
// cryptographic RNG): conditioning a uniform distribution on "is valid" yields
// a uniform distribution over the valid set.

export interface DrawInput {
  ids: string[];
  noGiveTo: Record<string, string | null | undefined>;
  noReceiveFrom: Record<string, string | null | undefined>;
}

export class DrawImpossibleError extends Error {
  constructor(message = 'No valid Secret Santa assignment exists with the current participants and preferences.') {
    super(message);
    this.name = 'DrawImpossibleError';
  }
}

const MAX_REJECTION_TRIES = 2_000_000;
const UINT32_RANGE = 0x1_0000_0000; // 2^32

/**
 * Uniform random integer in [0, maxExclusive) from crypto.getRandomValues.
 * Uses rejection to avoid modulo bias. globalThis.crypto is looked up at
 * call time (whenever the pool is refilled), so test setups that install it
 * after this module is loaded still work.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError('secureRandomInt: maxExclusive must be an integer in [1, 2^32]');
  }
  if (maxExclusive === 1) return 0;
  // Largest multiple of maxExclusive that fits in 2^32; values >= limit are rejected.
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  for (;;) {
    const x = nextRandomUint32();
    if (x < limit) return x % maxExclusive;
  }
}

// getRandomValues has a noticeable per-call overhead (notably in Node), so
// random words are fetched in blocks. Each word is used exactly once.
const RANDOM_POOL_SIZE = 1024;
const randomPool = new Uint32Array(RANDOM_POOL_SIZE);
let randomPoolPos = RANDOM_POOL_SIZE;

function nextRandomUint32(): number {
  if (randomPoolPos >= RANDOM_POOL_SIZE) {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== 'function') {
      throw new Error('secureRandomInt: crypto.getRandomValues is not available');
    }
    c.getRandomValues(randomPool);
    randomPoolPos = 0;
  }
  const x = randomPool[randomPoolPos];
  randomPool[randomPoolPos] = 0;
  randomPoolPos++;
  return x;
}

/** Pairwise rules (everything except the no-swap rule). */
export function isAllowed(giver: string, receiver: string, input: DrawInput): boolean {
  if (giver === receiver) return false;
  if (input.noGiveTo[giver] === receiver) return false;
  if (input.noReceiveFrom[receiver] === giver) return false;
  return true;
}

/** Full check: a is a permutation of input.ids, every pair allowed, no swaps. */
export function isValidAssignment(a: Map<string, string>, input: DrawInput): boolean {
  const ids = input.ids;
  if (a.size !== ids.length) return false;
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) return false;
  const receivers = new Set<string>();
  for (const [giver, receiver] of a) {
    if (!idSet.has(giver) || !idSet.has(receiver)) return false;
    if (receivers.has(receiver)) return false;
    receivers.add(receiver);
    if (!isAllowed(giver, receiver, input)) return false;
    if (a.get(receiver) === giver) return false; // swap
  }
  return receivers.size === ids.length;
}

function validateInput(input: DrawInput): void {
  if (!input || !Array.isArray(input.ids)) throw new TypeError('DrawInput.ids must be an array');
  for (const id of input.ids) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('DrawInput.ids must be non-empty strings');
  }
  if (new Set(input.ids).size !== input.ids.length) throw new TypeError('DrawInput.ids must be unique');
  if (!input.noGiveTo || typeof input.noGiveTo !== 'object') throw new TypeError('DrawInput.noGiveTo must be an object');
  if (!input.noReceiveFrom || typeof input.noReceiveFrom !== 'object') {
    throw new TypeError('DrawInput.noReceiveFrom must be an object');
  }
}

/**
 * With 3 people and no swaps only the two 3-cycles remain, so knowing your own
 * receiver reveals the whole draw. 4 is the smallest group that keeps it secret.
 */
export const MIN_PARTICIPANTS = 4;

/**
 * Depth-first search for a valid assignment. Optionally randomized via
 * `randomInt` (used by the fallback in drawAssignment). Returns the receiver
 * index for each giver index, or null if none exists.
 */
function backtrack(input: DrawInput, randomInt?: (n: number) => number): number[] | null {
  const ids = input.ids;
  const n = ids.length;
  if (n < MIN_PARTICIPANTS) return null;

  // allowed[g][r] precomputed on indices.
  const allowed: boolean[][] = [];
  for (let g = 0; g < n; g++) {
    const row: boolean[] = [];
    for (let r = 0; r < n; r++) row.push(isAllowed(ids[g], ids[r], input));
    allowed.push(row);
  }

  const order: number[] = ids.map((_, i) => i);
  if (randomInt) shuffleInPlace(order, randomInt);

  const receiverOf = new Array<number>(n).fill(-1); // giver index -> receiver index
  const taken = new Array<boolean>(n).fill(false); // receiver index used?

  const step = (k: number): boolean => {
    if (k === n) return true;
    const g = order[k];
    const candidates: number[] = [];
    for (let r = 0; r < n; r++) {
      if (taken[r] || !allowed[g][r]) continue;
      if (receiverOf[r] === g) continue; // would create a swap
      candidates.push(r);
    }
    if (randomInt) shuffleInPlace(candidates, randomInt);
    for (const r of candidates) {
      receiverOf[g] = r;
      taken[r] = true;
      if (step(k + 1)) return true;
      receiverOf[g] = -1;
      taken[r] = false;
    }
    return false;
  };

  return step(0) ? receiverOf : null;
}

/** True iff at least one valid assignment exists (backtracking search). */
export function hasValidAssignment(input: DrawInput): boolean {
  validateInput(input);
  return backtrack(input) !== null;
}

function shuffleInPlace<T>(arr: T[], randomInt: (n: number) => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

/**
 * Returns giver -> receiver. Uniform among valid assignments (rejection
 * sampling, up to 2,000,000 tries). If sampling fails: impossible inputs throw
 * DrawImpossibleError, otherwise a randomized backtracking result is returned.
 */
export function drawAssignment(
  input: DrawInput,
  randomInt: (n: number) => number = secureRandomInt,
): Map<string, string> {
  validateInput(input);
  const ids = input.ids;
  const n = ids.length;
  if (n < MIN_PARTICIPANTS) {
    throw new DrawImpossibleError(`At least ${MIN_PARTICIPANTS} participants are needed for the draw.`);
  }
  // Cheap early exit so impossible inputs don't spin through all rejection tries.
  if (!hasValidAssignment(input)) throw new DrawImpossibleError();

  // Precompute pairwise rules on indices.
  const allowed: boolean[][] = [];
  for (let g = 0; g < n; g++) {
    const row: boolean[] = [];
    for (let r = 0; r < n; r++) row.push(isAllowed(ids[g], ids[r], input));
    allowed.push(row);
  }

  const perm = new Array<number>(n); // perm[giverIndex] = receiverIndex
  for (let attempt = 0; attempt < MAX_REJECTION_TRIES; attempt++) {
    for (let i = 0; i < n; i++) perm[i] = i;
    shuffleInPlace(perm, randomInt);
    let ok = true;
    for (let g = 0; g < n && ok; g++) {
      const r = perm[g];
      if (!allowed[g][r] || perm[r] === g) ok = false;
    }
    if (ok) return toMap(ids, perm);
  }

  const fallback = backtrack(input, randomInt);
  if (!fallback) throw new DrawImpossibleError();
  return toMap(ids, fallback);
}

function toMap(ids: string[], receiverOf: number[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let g = 0; g < ids.length; g++) m.set(ids[g], ids[receiverOf[g]]);
  return m;
}
