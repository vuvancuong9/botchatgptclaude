process.env.AI_ORCHESTRATOR_API_KEY_PEPPER = "unit-test-pepper-aaaaaaaa";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
} from "../lib/ai-orchestrator/security/crypto";

test("encrypt → decrypt round-trips and hides the plaintext", () => {
  const blob = encryptSecret("sk-super-secret-value");
  assert.equal(blob.includes("sk-super-secret-value"), false);
  assert.equal(decryptSecret(blob), "sk-super-secret-value");
});

test("two encryptions of the same value differ (random IV)", () => {
  assert.notEqual(encryptSecret("same"), encryptSecret("same"));
});

test("tampered ciphertext fails to decrypt", () => {
  const blob = encryptSecret("x");
  const tampered = blob.slice(0, -3) + "AAA";
  assert.throws(() => decryptSecret(tampered));
});

test("encryptionConfigured reflects the pepper", () => {
  assert.equal(encryptionConfigured(), true);
  assert.equal(
    encryptionConfigured({ AI_ORCHESTRATOR_API_KEY_PEPPER: "" }),
    false,
  );
});

test("encrypt throws without a key", () => {
  assert.throws(() => encryptSecret("x", {}));
});
