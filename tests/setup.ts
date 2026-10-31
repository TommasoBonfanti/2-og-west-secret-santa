import { webcrypto } from 'node:crypto';

// Node 18 does not expose WebCrypto as a global by default.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
