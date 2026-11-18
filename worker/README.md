# Feedback relay

A Cloudflare Worker that forwards the extension's feedback form to Discord, so the Discord webhook
URL never ships in the extension or this repo.

## Deploy

1. In Discord, reset the old webhook (Channel settings → Integrations → Webhooks) and copy the new URL.
2. From this folder:

   ```bash
   npx wrangler login
   npx wrangler secret put DISCORD_WEBHOOK_URL   # paste the new webhook URL
   npx wrangler deploy
   ```

3. Put the deployed URL (`https://schedule-scoop-feedback.<your-subdomain>.workers.dev/`) in
   `FEEDBACK_ENDPOINT` at the top of `popup.js`.
4. Set `ALLOWED_ORIGINS` in `wrangler.toml` to `chrome-extension://<extension id>` (the published
   ID, plus any unpacked dev ID) and deploy again.

## What it enforces

- Only `feedback` (max 2,000 chars), `email` and `version` are accepted; the Worker builds the Discord message.
- Mentions are disabled (`allowed_mentions: { parse: [] }`), so `@everyone` can't ping anyone.
- 3 messages per IP per minute, and requests from other origins are refused when `ALLOWED_ORIGINS` is set.
