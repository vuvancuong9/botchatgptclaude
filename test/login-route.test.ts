process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as loginPost } from "../app/api/ai-orchestrator/auth/login/route";
import { POST as setPwPost } from "../app/api/ai-orchestrator/auth/set-password/route";
import { GET as meGet } from "../app/api/ai-orchestrator/me/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { hashPassword } from "../lib/ai-orchestrator/auth/password";
import { API_KEY_HEADER } from "../lib/ai-orchestrator/auth/api-key";

/* eslint-disable @typescript-eslint/no-explicit-any */
function loginReq(body: unknown) {
  return { headers: { get: () => null }, json: async () => body };
}
function authReq(headers: Record<string, string>, body: unknown = {}) {
  return {
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}

test("login with the correct password returns a working API key", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "owner@x.com", role: "owner" });
  await repo.updateUserPassword(user.id, hashPassword("password123"));

  const res = await loginPost(
    loginReq({ email: "owner@x.com", password: "password123" }) as any,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.api_key === "string" && data.api_key.startsWith("aiorch_"));
  assert.equal(data.user.role, "owner");

  // the minted key actually authenticates
  const me = await meGet(authReq({ [API_KEY_HEADER]: data.api_key }) as any);
  assert.equal(me.status, 200);
});

test("wrong password -> 401", async () => {
  const res = await loginPost(
    loginReq({ email: "owner@x.com", password: "nope" }) as any,
  );
  assert.equal(res.status, 401);
});

test("unknown email -> 401 (no enumeration)", async () => {
  const res = await loginPost(
    loginReq({ email: "ghost@x.com", password: "whatever1" }) as any,
  );
  assert.equal(res.status, 401);
});

test("a user can set their own password, then log in with it", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "dev@x.com", role: "developer" });
  await repo.updateUserPassword(user.id, hashPassword("firstpassword"));
  const login1 = await loginPost(
    loginReq({ email: "dev@x.com", password: "firstpassword" }) as any,
  );
  const key = (await login1.json()).api_key as string;

  const sp = await setPwPost(
    authReq({ [API_KEY_HEADER]: key }, { password: "brand-new-pass" }) as any,
  );
  assert.equal(sp.status, 200);

  const login2 = await loginPost(
    loginReq({ email: "dev@x.com", password: "brand-new-pass" }) as any,
  );
  assert.equal(login2.status, 200);
});

test("set-password rejects a too-short password", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@x.com", role: "viewer" });
  await repo.updateUserPassword(user.id, hashPassword("validpassword"));
  const key = (
    await (
      await loginPost(
        loginReq({ email: "v@x.com", password: "validpassword" }) as any,
      )
    ).json()
  ).api_key as string;
  const sp = await setPwPost(
    authReq({ [API_KEY_HEADER]: key }, { password: "short" }) as any,
  );
  assert.equal(sp.status, 400);
});
