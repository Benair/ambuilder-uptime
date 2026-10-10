# AM Builder uptime

Checks `https://api.ambuilder.ca/health` every 5 minutes and texts the owner
when it goes down and when it comes back (`.github/workflows/uptime.yml`).

- Runs on GitHub's servers, so it works when the server's own network is down.
- Texts only on a change of state.
- Twilio credentials and the phone number are encrypted repository secrets:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`,
  `ALERT_PHONE`.
- Send a test text: Actions → uptime → Run workflow → tick "Send a test text".
- `keepalive.yml` commits once a month so GitHub doesn't pause the schedule.
