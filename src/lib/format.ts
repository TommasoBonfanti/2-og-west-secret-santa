import { BackendError } from '../api/backend';

/** Friendly message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof BackendError) return e.message;
  console.error(e);
  if (e instanceof Error && e.message && !/fetch|network|TypeError/i.test(e.message)) return e.message;
  return 'Something went wrong. Please try again.';
}

export function formatMoney(amount: number, currency: string): string {
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${n} ${currency}`;
}

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** "Saturday 19 December 2026" (parsed as a local date: no timezone surprises). */
export function formatDate(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Whole days from today until the ISO date (negative if past). */
export function daysUntil(iso: string, now = new Date()): number {
  const target = parseIsoDate(iso).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

export function countdownText(iso: string): string {
  const days = daysUntil(iso);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return 'tomorrow!';
  if (days === 0) return 'today!';
  return 'already happened';
}

/** Stable pseudo-random number in [0, 1) from a string (for tilts etc.). */
export function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Stable tilt in degrees within ±max. */
export function tiltFor(seed: string, max = 6): number {
  return Math.round((hashUnit(seed) * 2 - 1) * max * 10) / 10;
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Rough strength hint for a password. Score 0 = too short. */
export function passwordStrength(pw: string, minLength: number): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length < minLength) {
    return { score: 0, label: `Too short — at least ${minLength} characters (${pw.length}/${minLength})` };
  }
  let score = 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const words = pw
    .trim()
    .split(/[\s\-_.]+/)
    .filter((w) => w.length >= 3).length;
  if (pw.length >= 14 || classes >= 3) score++;
  if (pw.length >= 20 || (words >= 4 && pw.length >= 16)) score++;
  if (/^(.)\1+$/.test(pw) || /password|123456|qwerty/i.test(pw)) score = 1;
  const labels = ['', 'Okay — a longer passphrase would be stronger', 'Good', 'Great — nice and strong'];
  return { score: score as 1 | 2 | 3, label: labels[score] };
}
