// Shared fakes: a recording fetch, Twilio env, and a Workers ctx.
import { vi } from "vitest";

export const ENV = {
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_MESSAGING_SERVICE_SID: "MGtest",
  ALERT_PHONE: "+15550000001",
};

// Replaces global fetch. `respond(url, init)` returns a Response (default 200 "{}").
export function mockFetch(respond = () => new Response("{}", { status: 200 })) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

// Twilio Messages API calls only, decoded.
export function texts(calls) {
  return calls
    .filter((c) => c.url.includes("api.twilio.com"))
    .map((c) => Object.fromEntries(new URLSearchParams(c.init.body)));
}

export function ctx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    settle: () => Promise.all(pending),
  };
}
