/** Small, crash-proof wrappers around localStorage for UI conveniences. */
const PREFIX = 'santa-ui:';

export function getPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function setPref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Who last logged in on this device, so "Welcome back, <name>" works after a reload. */
export interface LastUser {
  id: string;
  name: string;
}

export function getLastUser(): LastUser | null {
  const raw = getPref('last-user');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as LastUser;
    return v && typeof v.id === 'string' && typeof v.name === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function setLastUser(u: LastUser | null): void {
  setPref('last-user', u ? JSON.stringify(u) : null);
}
