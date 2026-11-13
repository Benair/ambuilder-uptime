// Phone-agent relay Worker: Retell recaps and the old Vapi relay.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../vapi/src/index.js";
import { ENV, ctx, mockFetch, texts } from "./helpers.js";

const RETELL_IP = "100.20.5.228";

function retell(body, ip = RETELL_IP) {
  return new Request("https://relay.example/retell", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const analyzed = (call = {}) => ({
  event: "call_analyzed",
  call: {
    from_number: "+15550000003",
    start_timestamp: Date.UTC(2026, 10, 12, 17, 0, 0),
    end_timestamp: Date.UTC(2026, 10, 12, 17, 2, 5),
    call_analysis: {
      call_summary: "Wants a demo of the AI receptionist.",
      custom_analysis_data: { caller_name: "Jordan", business: "Jordan Roofing", nested: { x: 1 }, empty: "" },
    },
    ...call,
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("Retell webhook", () => {
  it("refuses any IP but Retell's, and sends nothing", async () => {
    const calls = mockFetch();
    const c = ctx();
    const r = await worker.fetch(retell(analyzed(), "203.0.113.9"), ENV, c);
    await c.settle();
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects bad JSON", async () => {
    mockFetch();
    const r = await worker.fetch(retell("{not json"), ENV, ctx());
    expect(r.status).toBe(400);
  });

  it("ignores call_ended (no summary yet)", async () => {
    const calls = mockFetch();
    const c = ctx();
    const r = await worker.fetch(retell({ event: "call_ended", call: {} }), ENV, c);
    await c.settle();
    expect(r.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("answers Retell without waiting on Twilio (Retell retries after 10 s)", async () => {
    let release;
    const twilioDone = new Promise((r) => (release = r));
    mockFetch(async () => {
      await twilioDone; // Twilio is slow
      return new Response("{}", { status: 201 });
    });
    const c = ctx();
    const r = await worker.fetch(retell(analyzed()), ENV, c);
    expect(r.status).toBe(204); // answered while the text is still in flight
    release();
    await c.settle();
  });

  it("texts a recap on call_analyzed", async () => {
    const calls = mockFetch();
    const c = ctx();
    const r = await worker.fetch(retell(analyzed()), ENV, c);
    expect(r.status).toBe(204);
    await c.settle();

    const [sms] = texts(calls);
    expect(sms.To).toBe(ENV.ALERT_PHONE);
    expect(sms.MessagingServiceSid).toBe("MGtest");
    expect(sms.Body).toContain("Riley took a call from +15550000003");
    expect(sms.Body).toContain("2m 5s");
    expect(sms.Body).toContain("Caller name: Jordan");
    expect(sms.Body).toContain("Business: Jordan Roofing");
    expect(sms.Body).not.toContain("Nested"); // objects skipped
    expect(sms.Body).not.toContain("Empty:"); // blanks skipped
    expect(sms.Body).toContain("Wants a demo of the AI receptionist.");
    expect(calls[0].init.headers.authorization).toBe(`Basic ${btoa("ACtest:token")}`);
  });

  it("says when the call was transferred", async () => {
    const calls = mockFetch();
    const c = ctx();
    await worker.fetch(retell(analyzed({ disconnection_reason: "call_transfer" })), ENV, c);
    await c.settle();
    expect(texts(calls)[0].Body).toContain("Transferred to you.");
  });

  it("keeps a long recap within one 1500-character message", async () => {
    const calls = mockFetch();
    const c = ctx();
    const long = analyzed();
    long.call.call_analysis.call_summary = "x".repeat(5000);
    await worker.fetch(retell(long), ENV, c);
    await c.settle();
    expect(texts(calls)[0].Body.length).toBe(1500);
  });

  it("survives Twilio failing (logged, not thrown)", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    const c = ctx();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.fetch(retell(analyzed()), ENV, c);
    await expect(c.settle()).resolves.toBeDefined();
    expect(log).toHaveBeenCalledWith("recap text failed", expect.stringContaining("twilio 500"));
  });
});

describe("Vapi relay", () => {
  const vapi = (body, secret = "s3cret") =>
    new Request("https://relay.example/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-secret": secret },
      body: JSON.stringify(body),
    });

  it("answers GET without doing anything", async () => {
    const calls = mockFetch();
    const r = await worker.fetch(new Request("https://relay.example/"), ENV, ctx());
    expect(await r.text()).toBe("ok");
    expect(calls).toHaveLength(0);
  });

  it("drops everything but end-of-call-report", async () => {
    const calls = mockFetch();
    const r = await worker.fetch(vapi({ message: { type: "status-update" } }), ENV, ctx());
    expect(await r.json()).toEqual({ status: "ignored", type: "status-update" });
    expect(calls).toHaveLength(0);
  });

  it("forwards the report to the server with Vapi's secret passed through", async () => {
    const calls = mockFetch(() => Response.json({ status: "ok" }));
    const body = { message: { type: "end-of-call-report", analysis: {} } };
    const r = await worker.fetch(vapi(body), ENV, ctx());
    expect(r.status).toBe(200);
    expect(calls[0].url).toBe("https://api.ambuilder.ca/vapi/call-summary");
    expect(calls[0].init.headers["x-vapi-secret"]).toBe("s3cret");
    expect(JSON.parse(calls[0].init.body)).toEqual(body);
  });

  it("passes the server's refusal back to Vapi", async () => {
    mockFetch(() => new Response('{"detail":"unauthorized"}', { status: 401 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await worker.fetch(vapi({ message: { type: "end-of-call-report" } }, "wrong"), ENV, ctx());
    expect(r.status).toBe(401);
  });
});
