import { test } from "node:test";
import assert from "node:assert/strict";

import { createLazyCipher } from "../src/main/cipher.js";

// A stand-in for Electron's `safeStorage`, recording how often each method runs
// so tests can prove the keychain is only touched when a cipher op is performed.
function fakeSafeStorage({ available = true } = {}) {
  const calls = { isAvail: 0, enc: 0, dec: 0 };
  return {
    calls,
    isEncryptionAvailable() {
      calls.isAvail++;
      return available;
    },
    encryptString(plain) {
      calls.enc++;
      return Buffer.from("enc:" + plain);
    },
    decryptString(buf) {
      calls.dec++;
      return String(buf).replace(/^enc:/, "");
    },
  };
}

// This is the behaviour that fixes the first-run keychain prompt: merely holding
// a reference to `decrypt` (as loadToken does when no token file exists) must NOT
// probe the keychain. isEncryptionAvailable() runs only when an op is invoked.
test("does not touch safeStorage until a cipher op is actually performed", () => {
  const ss = fakeSafeStorage();
  const cipher = createLazyCipher(() => ss);

  const decryptRef = cipher.decrypt; // what loadToken receives and may never call
  assert.equal(typeof decryptRef, "function");
  assert.equal(ss.calls.isAvail, 0, "isEncryptionAvailable must not run before use");
  assert.equal(cipher.isInitialized(), false);
});

test("decrypt lazily initializes only when invoked, and round-trips", () => {
  const ss = fakeSafeStorage();
  const cipher = createLazyCipher(() => ss);

  assert.equal(cipher.decrypt(Buffer.from("enc:tok")), "tok");
  assert.equal(ss.calls.isAvail, 1);
  assert.equal(ss.calls.dec, 1);
});

test("resolveEncrypt returns a working encrypt fn and probes the keychain once", () => {
  const ss = fakeSafeStorage();
  const cipher = createLazyCipher(() => ss);

  const enc = cipher.resolveEncrypt();
  assert.equal(typeof enc, "function");
  assert.equal(String(enc("tok")), "enc:tok");

  cipher.resolveEncrypt(); // second resolve must reuse the memoized result
  assert.equal(ss.calls.isAvail, 1, "isEncryptionAvailable must be memoized to one call");
});

test("when encryption is unavailable: resolveEncrypt is null, decrypt throws (so callers fall back)", () => {
  const ss = fakeSafeStorage({ available: false });
  const cipher = createLazyCipher(() => ss);

  assert.equal(cipher.resolveEncrypt(), null);
  assert.throws(() => cipher.decrypt(Buffer.from("enc:tok")));
});

test("tolerates a throwing safeStorage provider (e.g. not running under Electron)", () => {
  const cipher = createLazyCipher(() => {
    throw new Error("safeStorage unavailable");
  });

  assert.equal(cipher.resolveEncrypt(), null);
  assert.throws(() => cipher.decrypt(Buffer.from("enc:tok")));
});
