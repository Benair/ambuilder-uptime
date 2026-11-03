#!/bin/bash
# Copies the Twilio settings from news-platform/.env into this Worker's secrets, then deploys it.
cd "$(dirname "$0")"
W=../worker/node_modules/.bin/wrangler
ENV='C:\Users\Adrian\Projects\news-platform\.env'
for pair in TWILIO_ACCOUNT_SID:TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN:TWILIO_AUTH_TOKEN \
            TWILIO_MESSAGING_SERVICE_SID:TWILIO_MESSAGING_SERVICE_SID ALERT_PHONE:OPERATOR_PHONE; do
  name=${pair%%:*}; src=${pair##*:}
  python -c "from dotenv import dotenv_values; import sys; sys.stdout.write(dotenv_values(r'$ENV')['$src'])" \
    | $W secret put "$name" 2>&1 | grep -iE "success|error" | head -1
done
$W deploy 2>&1 | grep -iE "deployed|https://|error" | head -5
echo "done"
