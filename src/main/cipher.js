// Lazy, memoized safeStorage-backed token cipher.
//
// Why this exists: Electron's macOS `safeStorage` is backed by the login
// Keychain, and `safeStorage.isEncryptionAvailable()` is NOT lazy — calling it
// reads/creates the app's keychain item, which on an unsigned build pops a
// "wants to use your confidential information stored in your keychain" prompt
// (Electron #45328). Probing it eagerly at startup made a fresh, no-token first
// run prompt for credentials before the user did anything.
//
// The fix: never probe until a token is actually read or written.
//   • `decrypt` is a STABLE function reference that can be passed to loadToken
//     and held without side effects — it only probes when actually CALLED (i.e.
//     when an encrypted token file exists). A no-token launch never calls it, so
//     the keychain is never touched.
//   • `resolveEncrypt()` probes now (callers invoke it at save time, when the
//     user is deliberately persisting a token), returning the encrypt fn or null
//     so callers keep the existing encrypted-or-plaintext fallback.
//
// `getSafeStorage` is injected so this is unit-testable without Electron.
export function createLazyCipher(getSafeStorage) {
  let impl; // { encrypt, decrypt } once available, or null when unavailable
  let initialized = false;

  // Probe + memoize. `safeStorage.isEncryptionAvailable()` runs at most once,
  // the first time a cipher op truly needs it. A throwing provider (e.g. not
  // running under Electron) is treated the same as "unavailable".
  function ensure() {
    if (initialized) return impl;
    initialized = true;
    try {
      const ss = getSafeStorage();
      impl =
        ss && ss.isEncryptionAvailable()
          ? {
              encrypt: (plain) => ss.encryptString(plain),
              decrypt: (buf) => ss.decryptString(buf),
            }
          : null;
    } catch {
      impl = null;
    }
    return impl;
  }

  return {
    // Stable ref: holding it is free; only calling it probes the keychain.
    // Throws when encryption is unavailable so loadToken's try/catch falls back
    // to the plaintext file (matching the previous undefined-decrypt behaviour).
    decrypt: (buf) => {
      const c = ensure();
      if (!c) throw new Error("safeStorage encryption is unavailable");
      return c.decrypt(buf);
    },
    // Resolve the encrypt fn at save time, or null to fall back to plaintext.
    resolveEncrypt: () => ensure()?.encrypt ?? null,
    // Test/inspection aid: has the keychain been probed yet?
    isInitialized: () => initialized,
  };
}
