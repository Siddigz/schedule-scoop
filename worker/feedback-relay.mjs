// Cloudflare Worker that relays ScheduleScoop feedback to Discord.
// The Discord webhook URL lives only in this Worker's secrets (DISCORD_WEBHOOK_URL), never in the
// extension or the repo. The Worker builds the Discord message itself, so callers can only send
// a message, an optional email and a version, never arbitrary Discord content.
//
// Bindings (see wrangler.toml):
//   DISCORD_WEBHOOK_URL  secret, the Discord webhook (wrangler secret put DISCORD_WEBHOOK_URL)
//   ALLOWED_ORIGINS      optional, comma-separated origins, e.g. chrome-extension://<extension id>
//   FEEDBACK_LIMITER     optional rate-limit binding, keyed by client IP

export const MAX_FEEDBACK = 2000;
const MAX_EMAIL = 254;
const MAX_VERSION = 32;
const AVATAR_URL = 'https://raw.githubusercontent.com/nolandruid/schedule-scoop/main/images/calendar128.png';

const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Validates the request body and builds the Discord webhook payload, or returns { error }. */
export function buildDiscordPayload(body, now = new Date()) {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  const feedback = clean(body.feedback, MAX_FEEDBACK);
  if (!feedback) return { error: 'Feedback is required' };
  const email = clean(body.email, MAX_EMAIL);
  const version = clean(body.version, MAX_VERSION);

  // Stop the text closing the code block early.
  const safeFeedback = feedback.replace(/```/g, '`​`​`');

  return {
    payload: {
      username: 'Schedule Scoop Feedback',
      avatar_url: AVATAR_URL,
      // Never ping anyone (@everyone, @here, users or roles), whatever the feedback text says.
      allowed_mentions: { parse: [] },
      embeds: [{
        description: `\`\`\`\n${safeFeedback}\n\`\`\``,
        color: 0x4f46e5,
        fields: [
          { name: 'Contact Email', value: email || 'Anonymous', inline: false },
          { name: 'Version', value: version || 'Unknown', inline: false },
        ],
        timestamp: now.toISOString(),
      }],
    },
  };
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!allowed.length) return origin || '*';
  return allowed.includes(origin) ? origin : null;
}

const respond = (status, body, origin) => new Response(body ? JSON.stringify(body) : null, {
  status,
  headers: {
    'Content-Type': 'application/json',
    ...(origin && {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }),
  },
});

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (origin === null) return respond(403, { error: 'Origin not allowed' });
    if (request.method === 'OPTIONS') return respond(204, null, origin);
    if (request.method !== 'POST') return respond(405, { error: 'Method not allowed' }, origin);

    if (env.FEEDBACK_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.FEEDBACK_LIMITER.limit({ key: ip });
      if (!success) return respond(429, { error: 'Too many requests' }, origin);
    }

    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > 16 * 1024) return respond(413, { error: 'Too large' }, origin);

    let body;
    try { body = await request.json(); } catch { return respond(400, { error: 'Invalid JSON' }, origin); }
    const { payload, error } = buildDiscordPayload(body);
    if (error) return respond(400, { error }, origin);

    if (!env.DISCORD_WEBHOOK_URL) return respond(500, { error: 'Relay not configured' }, origin);
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return respond(502, { error: 'Discord rejected the message' }, origin);
    return respond(200, { ok: true }, origin);
  },
};
