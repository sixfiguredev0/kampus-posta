import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.MAIL_MODE = 'local';
process.env.MAIL_DATA_DIRECTORY = await mkdtemp(join(tmpdir(), 'campus-store-test-'));
process.env.APP_KEY = Buffer.alloc(32, 7).toString('base64');
const { get, put } = await import('../lib/store.mjs');

test('an expired claim (e.g. a Sent-copy lock left by a crashed request) can be claimed again', async () => {
  // A request that dies inside copySent never runs its `finally`, so the lock row outlives its expiry.
  assert.equal(await put('lock:send:a:b', true, Date.now() - 1, 'claim'), true);
  assert.equal(await get('lock:send:a:b'), null);
  assert.equal(await put('lock:send:a:b', true, Date.now() + 60_000, 'claim'), true);
  assert.equal(await put('lock:send:a:b', true, Date.now() + 60_000, 'claim'), false);
});
