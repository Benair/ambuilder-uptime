// AM Builder phone-agent relay — a Cloudflare Worker.
//
// POST /retell — Retell's agent webhook (Riley on 825-451-9153, since 2026-11-03).
//   On call_analyzed, texts the operator a recap straight through Twilio, so the
//   recap doesn't depend on gingaserver being up. Only Retell's webhook IP is
//   accepted (docs.retellai.com/features/webhook-overview), so no secret is needed
//   here; forged reports could otherwise text the operator's phone.
//
// POST / — the old Vapi relay. Vapi posts call reports from datacenter IPs, and the
//   ambuilder.ca zone's bot protection answers those with 403 before they reach the
//   server, so Vapi pointed here and this forwards the end-of-call-report from inside
//   Cloudflare. Vapi's x-vapi-secret header is passed through and checked by the
//   server (news-platform src/routes/vapi.py).
//
// Secrets (wrangler secret put): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_MESSAGING_SERVICE_SID, ALERT_PHONE (the operator's cell).

const ENDPOINT = "https://api.ambuilder.ca/vapi/call-summary";
const RETELL_IPS = ["100.20.5.228"];

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("ok");
    const url = new URL(request.url);
    if (url.pathname === "/retell") return retell(request, env, ctx);
    return vapi(request);
  },
};

async function retell(request, env, ctx) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!RETELL_IPS.includes(ip)) {
    console.log("retell webhook refused from", ip);
    return new Response("forbidden", { status: 403 });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  // call_ended comes first without the summary; call_analyzed follows with it.
  if (payload.event !== "call_analyzed" || !payload.call) return new Response(null, { status: 204 });

  // Answer Retell straight away (it retries after 10 s); the text goes out after.
  ctx.waitUntil(
    sendText(env, recap(payload.call)).catch((e) => console.log("recap text failed", String(e))),
  );
  return new Response(null, { status: 204 });
}

function recap(call) {
  const a = call.call_analysis || {};
  const custom = a.custom_analysis_data || {};
  const caller = call.from_number || "unknown number";
  const secs = call.start_timestamp && call.end_timestamp
    ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
    : null;
  const when = call.start_timestamp
    ? new Date(call.start_timestamp).toLocaleString("en-CA", {
        timeZone: "America/Edmonton", weekday: "short", hour: "numeric", minute: "2-digit",
      })
    : "";
  const lines = [`📞 Riley took a call from ${caller}`];
  if (when || secs != null) {
    lines.push([when, secs != null ? `${Math.floor(secs / 60)}m ${secs % 60}s` : ""].filter(Boolean).join(" · "));
  }
  // Whatever post-call fields are set up in Retell (name, business, need…), one per line.
  for (const [k, v] of Object.entries(custom)) {
    if (v !== null && v !== "" && typeof v !== "object") lines.push(`${label(k)}: ${v}`);
  }
  if (a.call_summary) lines.push("", a.call_summary);
  if (call.disconnection_reason === "call_transfer") lines.push("", "Transferred to you.");
  return lines.join("\n").slice(0, 1500);
}

function label(key) {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function sendText(env, body) {
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
  if (!resp.ok) throw new Error(`twilio ${resp.status}: ${await resp.text()}`);
}

async function vapi(request) {
  const body = await request.text();
  let type = "";
  try {
    const payload = JSON.parse(body);
    type = (payload.message && payload.message.type) || payload.type || "";
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (type !== "end-of-call-report") {
    return Response.json({ status: "ignored", type });
  }

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vapi-secret": request.headers.get("x-vapi-secret") || "",
    },
    body,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  if (!resp.ok) console.log("server answered", resp.status, text);
  return new Response(text, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}
