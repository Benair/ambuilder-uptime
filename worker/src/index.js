// AM Builder uptime monitor — a Cloudflare Worker on a one-minute cron.
//
// Checks https://api.ambuilder.ca/health and texts the owner through Twilio
// when it goes down and when it comes back. It runs inside Cloudflare because
// the zone's bot protection challenges outside monitors (GitHub Actions got
// "403 Just a moment..." on 2026-10-10), so they can't see the server at all.
//
// Down means the API didn't answer 200 on three tries ~10s apart, so a single
// dropped request isn't an outage. Texts go out only on a change of state; the
// state lives in KV and is written only when it changes, which keeps the free
// plan's KV write limit out of reach.
//
// Secrets (wrangler secret put): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_MESSAGING_SERVICE_SID, ALERT_PHONE, TEST_KEY (for the test-text URL only).

const TARGET = "https://api.ambuilder.ca/health";
const TRIES = 3;
const GAP_MS = 10_000;

async function probe() {
  let last = "no answer";
  for (let i = 0; i < TRIES; i++) {
    try {
      const resp = await fetch(TARGET, {
        headers: { "user-agent": "ambuilder-uptime-worker/1.0" },
        cf: { cacheTtl: 0, cacheEverything: false },
        signal: AbortSignal.timeout(12_000),
      });
      if (resp.status === 200) return { up: true, detail: "200" };
      last = String(resp.status);
    } catch (err) {
      last = err && err.name === "TimeoutError" ? "timed out" : "no answer";
    }
    if (i < TRIES - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return { up: false, detail: last };
}

async function text(env, body) {
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: env.ALERT_PHONE,
        MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
        Body: body,
      }),
    },
  );
  return resp.status;
}

function calgaryTime(ms) {
  return new Date(ms).toLocaleTimeString("en-CA", {
    timeZone: "America/Edmonton", hour: "numeric", minute: "2-digit",
  });
}

async function check(env) {
  const now = Date.now();
  const result = await probe();
  const saved = (await env.STATE.get("state", "json")) || { up: true, since: now };

  if (saved.up && !result.up) {
    await text(env,
      `ALERT: api.ambuilder.ca is DOWN (${result.detail}) as of ${calgaryTime(now)}. Dashboard, demos, ` +
      `call recaps and text replies are offline. Usually the server's network: check the cable and power.`);
    await env.STATE.put("state", JSON.stringify({ up: false, since: now }));
  } else if (!saved.up && result.up) {
    const mins = Math.max(1, Math.round((now - saved.since) / 60_000));
    await text(env, `OK: api.ambuilder.ca is back up as of ${calgaryTime(now)}, after about ${mins} min down.`);
    await env.STATE.put("state", JSON.stringify({ up: true, since: now }));
  }
  return { ...result, was: saved.up ? "up" : "down" };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  // GET /                → what the monitor sees right now, without texting anyone.
  // GET /?test=<TEST_KEY> → also send a test text, to prove alerts reach the phone.
  // The key is a secret, so nobody who finds this URL can make it text the owner.
  async fetch(request, env) {
    const url = new URL(request.url);
    const result = await probe();
    let sent = null;
    const key = url.searchParams.get("test");
    if (key && env.TEST_KEY && key === env.TEST_KEY) {
      sent = await text(env, "AM Builder uptime alerts are live, checking every minute from Cloudflare. " +
        "(Ignore the earlier DOWN text: that was a false alarm from the first setup.)");
    }
    const saved = await env.STATE.get("state", "json");
    return Response.json({ target: TARGET, now: result, stored: saved, test_text_status: sent });
  },
};
