# AM Builder uptime

A Cloudflare Worker (`worker/`) checks `https://api.ambuilder.ca/health`
every minute and texts the owner through Twilio when it goes down and again
when it comes back.

- Runs inside Cloudflare. The zone's bot protection challenges outside monitors
  (GitHub Actions got `403 Just a moment...`), so an external checker can't see
  the server at all. A Worker isn't challenged.
- Down = no 200 on three tries ~10 s apart. Texts only on a change of state;
  state lives in Workers KV and is written only when it changes.
- Secrets (set with `npx wrangler secret put NAME` in `worker/`):
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`,
  `ALERT_PHONE`, `TEST_KEY`.
- See what it sees: open the worker URL. Send a test text: add `?test=<TEST_KEY>`.
- Deploy changes: `cd worker && npx wrangler deploy`.

The first version used a GitHub Actions schedule; it was removed for the
reason above.

## Email replies (`replies/`)

A Cloudflare Email Worker for customers' replies to automation emails. Those
emails carry `Reply-To: reply+<code>@ambuilder.ca`; Email Routing (subaddressing
on, `reply@ambuilder.ca` → this Worker) delivers the reply here, and the Worker
posts it to `https://api.ambuilder.ca/email/inbound`. The server stops that
customer's follow-ups and forwards the reply to the business owner. If the
server can't be reached, the message is forwarded to the `FALLBACK` address.

Secrets: `INBOUND_SECRET` (same as the server's `.env`), `FALLBACK`.
