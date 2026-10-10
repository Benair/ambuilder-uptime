// AM Builder replies — a Cloudflare Email Worker.
//
// Automation emails go out with Reply-To: reply+<code>@ambuilder.ca. Email
// Routing (subaddressing on, reply@ambuilder.ca -> this Worker) delivers the
// customer's reply here. We parse it and post it to the AM Builder server,
// which stops that customer's follow-ups and forwards the reply to the business
// owner (news-platform src/routes/email_inbound.py).
//
// If the server can't be reached, the message is forwarded to FALLBACK (a
// verified Email Routing destination) so a reply is never lost.
//
// Secret: INBOUND_SECRET (same value as the server's .env).
// Var:    FALLBACK (wrangler.toml).

import PostalMime from "postal-mime";

const ENDPOINT = "https://api.ambuilder.ca/email/inbound";

function sender(parsed, envelopeFrom) {
  const f = parsed.from;
  if (!f || !f.address) return envelopeFrom;
  return f.name ? `${f.name} <${f.address}>` : f.address;
}

function textOf(parsed) {
  if (parsed.text) return parsed.text;
  return (parsed.html || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/\s+\n/g, "\n").trim();
}

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const headers = {};
    for (const [k, v] of message.headers) headers[k] = v;

    let ok = false;
    try {
      const resp = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-inbound-secret": env.INBOUND_SECRET },
        body: JSON.stringify({
          to: message.to,
          from: sender(parsed, message.from),
          subject: parsed.subject || "",
          text: textOf(parsed).slice(0, 20000),
          headers,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      ok = resp.ok;
      if (!ok) console.log("server answered", resp.status);
    } catch (err) {
      console.log("server unreachable", String(err));
    }

    if (!ok && env.FALLBACK) {
      await message.forward(env.FALLBACK);
    }
  },
};
