import { test } from 'node:test';
import assert from 'node:assert/strict';
import relay, { buildDiscordPayload, MAX_FEEDBACK } from '../worker/feedback-relay.mjs';

test('payload blocks all mentions and keeps only known fields', () => {
  const { payload } = buildDiscordPayload({ feedback: '@everyone hi', email: 'a@b.c', version: '3.0.0', content: 'x' });
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.content, undefined);
  assert.match(payload.embeds[0].description, /@everyone hi/);
  assert.equal(payload.embeds[0].fields[0].value, 'a@b.c');
});

test('payload trims long feedback and rejects empty feedback', () => {
  const { payload } = buildDiscordPayload({ feedback: 'x'.repeat(5000) });
  assert.ok(payload.embeds[0].description.length <= MAX_FEEDBACK + 10);
  assert.ok(buildDiscordPayload({ feedback: '   ' }).error);
  assert.ok(buildDiscordPayload(null).error);
});

test('feedback cannot close the code block', () => {
  const { payload } = buildDiscordPayload({ feedback: 'a ``` b' });
  assert.equal(payload.embeds[0].description.split('```').length, 3);
});

test('relay refuses other origins and forwards allowed ones', async () => {
  const env = { ALLOWED_ORIGINS: 'chrome-extension://abc', DISCORD_WEBHOOK_URL: 'https://discord.test/hook' };
  const req = (origin) => new Request('https://relay.test/', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback: 'hi' }),
  });
  assert.equal((await relay.fetch(req('https://evil.test'), env)).status, 403);

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };
  try {
    const res = await relay.fetch(req('chrome-extension://abc'), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://abc');
    assert.equal(sent[0].url, 'https://discord.test/hook');
    assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('relay enforces the rate limit', async () => {
  const env = { DISCORD_WEBHOOK_URL: 'x', FEEDBACK_LIMITER: { limit: async () => ({ success: false }) } };
  const res = await relay.fetch(new Request('https://relay.test/', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 429);
});
