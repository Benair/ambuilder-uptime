// Uptime monitor: texts only on a change of state, and tolerates one bad request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/src/index.js";
import { ENV, ctx, mockFetch, texts } from "./helpers.js";

function kv(initial) {
  const store = new Map(initial ? [["state", JSON.stringify(initial)]] : []);
  return {
    writes: 0,
    async get(k, type) {
      const v = store.get(k);
      return v == null ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      this.writes++;
      store.set(k, v);
    },
  };
}

// health: a list of statuses the API returns in turn (last one repeats).
function api(...health) {
  let i = 0;
  return mockFetch((url) => {
    if (url.includes("api.twilio.com")) return new Response("{}", { status: 201 });
    const s = health[Math.min(i++, health.length - 1)];
    if (s === "timeout") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    return new Response("", { status: s });
  });
}

async function tick(env) {
  const c = ctx();
  const run = (async () => {
    await worker.scheduled({}, env, c);
    await c.settle();
  })();
  await vi.runAllTimersAsync(); // the 10 s gaps between retries
  await run;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("uptime cron", () => {
  it("steady and up: no text, no KV write", async () => {
    const calls = api(200);
    const env = { ...ENV, STATE: kv({ up: true, since: 0 }) };
    await tick(env);
    expect(texts(calls)).toHaveLength(0);
    expect(env.STATE.writes).toBe(0);
  });

  it("one failed request then 200 is not an outage", async () => {
    const calls = api(502, 200);
    const env = { ...ENV, STATE: kv({ up: true, since: 0 }) };
    await tick(env);
    expect(texts(calls)).toHaveLength(0);
  });

  it("three failures: texts DOWN once and records it", async () => {
    const calls = api(530);
    const env = { ...ENV, STATE: kv({ up: true, since: 0 }) };
    await tick(env);
    const [sms] = texts(calls);
    expect(sms.Body).toMatch(/^ALERT: api\.ambuilder\.ca is DOWN \(530\)/);
    expect(JSON.parse(await env.STATE.get("state"))).toMatchObject({ up: false });

    // Still down next minute: no second text.
    const again = api(530);
    await tick(env);
    expect(texts(again)).toHaveLength(0);
  });

  it("reports timeouts by name", async () => {
    const calls = api("timeout");
    const env = { ...ENV, STATE: kv({ up: true, since: 0 }) };
    await tick(env);
    expect(texts(calls)[0].Body).toContain("(timed out)");
  });

  it("back up: texts OK with how long it was down", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 12, 18, 0, 0));
    const calls = api(200);
    const env = { ...ENV, STATE: kv({ up: false, since: Date.UTC(2026, 10, 12, 17, 45, 0) }) };
    await tick(env);
    expect(texts(calls)[0].Body).toContain("back up");
    expect(texts(calls)[0].Body).toContain("after about 15 min down");
  });
});

describe("status page", () => {
  it("never texts without the right test key", async () => {
    vi.useRealTimers();
    const calls = api(200);
    const env = { ...ENV, TEST_KEY: "k", STATE: kv() };
    for (const url of ["https://w.example/", "https://w.example/?test=wrong", "https://w.example/?test="]) {
      const r = await worker.fetch(new Request(url), env);
      expect((await r.json()).test_text_status).toBeNull();
    }
    expect(texts(calls)).toHaveLength(0);
  });

  it("sends a test text with the right key", async () => {
    vi.useRealTimers();
    const calls = api(200);
    const env = { ...ENV, TEST_KEY: "k", STATE: kv() };
    const r = await worker.fetch(new Request("https://w.example/?test=k"), env);
    expect((await r.json()).test_text_status).toBe(201);
    expect(texts(calls)).toHaveLength(1);
  });
});
