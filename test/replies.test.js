// Email replies Worker: post to the server; if that fails, never lose the email.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../replies/src/index.js";
import { mockFetch } from "./helpers.js";

const RAW = [
  "From: Sam Customer <sam@example.com>",
  "To: reply+abc123@ambuilder.ca",
  "Subject: Re: your quote",
  "Auto-Submitted: no",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Yes please, Tuesday works.",
  "",
].join("\r\n");

function message() {
  const forwarded = [];
  return {
    forwarded,
    from: "bounce@example.com",
    to: "reply+abc123@ambuilder.ca",
    raw: new Response(RAW).body,
    headers: new Headers({ subject: "Re: your quote", "auto-submitted": "no" }),
    forward: async (to) => forwarded.push(to),
  };
}

const ENV = { INBOUND_SECRET: "s3cret", FALLBACK: "owner@example.com" };

afterEach(() => vi.unstubAllGlobals());

describe("email replies", () => {
  it("posts the parsed reply to the server with the secret", async () => {
    const calls = mockFetch(() => Response.json({ ok: true }));
    const m = message();
    await worker.email(m, ENV);

    expect(calls[0].url).toBe("https://api.ambuilder.ca/email/inbound");
    expect(calls[0].init.headers["x-inbound-secret"]).toBe("s3cret");
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({
      to: "reply+abc123@ambuilder.ca",
      from: "Sam Customer <sam@example.com>",
      subject: "Re: your quote",
    });
    expect(body.text).toContain("Tuesday works");
    expect(body.headers["auto-submitted"]).toBe("no");
    expect(m.forwarded).toEqual([]); // server took it: no fallback
  });

  it("forwards to FALLBACK when the server refuses", async () => {
    mockFetch(() => new Response("", { status: 502 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const m = message();
    await worker.email(m, ENV);
    expect(m.forwarded).toEqual(["owner@example.com"]);
  });

  it("forwards to FALLBACK when the server is unreachable", async () => {
    mockFetch(() => {
      throw new TypeError("network down");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const m = message();
    await worker.email(m, ENV);
    expect(m.forwarded).toEqual(["owner@example.com"]);
  });
});
