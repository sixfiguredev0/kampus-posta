import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.MAIL_MODE = 'local';
process.env.MAIL_DATA_DIRECTORY = await mkdtemp(join(tmpdir(), 'campus-ops-test-'));
process.env.APP_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.OPS_INGEST_TOKEN = 'x'.repeat(40);
const { applySample, report, ingest, opsReport, opsViewer } = await import('../lib/ops.mjs');
const { parseStat, parseMeminfo, parseNetDev } = await import('../ops/collector.mjs');

const GB = 1024 ** 3;
const sample = (t, i, extra = {}) => ({
  t, host: 'relay-vm', uptime: 1000 + i, load: 0.2,
  cpu: { busy: 1000 + i * 30, idle: 10000 + i * 240, steal: 100 + i * 30 },
  mem: { total: GB, available: GB * 0.6, swapTotal: 0, swapFree: 0 },
  net: { rx: i * 300_000, tx: i * 150_000 },
  disk: { total: 45 * GB, free: 30 * GB - i * 1_000_000 },
  services: [{ name: 'kampus-relay', memory: 40e6, cpu: i * 3_000_000 }],
  ...extra,
});

test('collector parsers read /proc formats', () => {
  assert.deepEqual(parseStat('cpu  10 2 3 100 5 1 1 7 0 0\ncpu0 1 1 1 1'), { busy: 17, idle: 105, steal: 7, iowait: 5 });
  assert.deepEqual(parseMeminfo('MemTotal:       1000 kB\nMemAvailable:    400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB'),
    { total: 1024000, available: 409600, swapTotal: 0, swapFree: 0 });
  assert.deepEqual(parseNetDev('h1\nh2\n    lo: 999 0 0 0 0 0 0 0 999 0\n  ens3: 100 0 0 0 0 0 0 0 50 0'), { rx: 100, tx: 50 });
});

test('samples become points, hourly buckets and a verdict', () => {
  const start = Date.UTC(2026, 10, 1);
  let state;
  for (let i = 0; i < 12 * 30; i++) state = applySample(state, sample(start + i * 300_000, i));
  assert.equal(state.recent.length, 12 * 30 - 1); // the first sample only sets the baseline
  assert.ok(state.hourly.length >= 29);
  const point = state.recent.at(-1);
  assert.equal(point.cpu, 10); // 30 busy of 300 ticks
  assert.equal(point.steal, 10);
  assert.equal(point.mem, 40);
  assert.equal(point.rx, 1000);
  const r = report(state, start + 12 * 30 * 300_000);
  assert.equal(r.level, 'warning'); // low CPU and network for a day → Oracle idle-reclaim warning
  assert.ok(r.checks.some(c => c.label.startsWith('Риск Oracle')));
  assert.ok(r.daysToFull > 0);
  assert.equal(r.services[0].cpu, 1); // 3 s of CPU per 300 s = 1% of a core
});

test('a reboot (counters reset) records no bogus point', () => {
  const start = Date.UTC(2026, 10, 1);
  let state = applySample(undefined, sample(start, 10));
  state = applySample(state, sample(start + 300_000, 0));
  assert.equal(state.recent.length, 0);
});

test('ingest needs the bearer token and a valid sample; viewers come from OPS_USERS', async () => {
  const post = (body, token) => ingest(new Request('http://x/api/ops', {
    method: 'POST', body: JSON.stringify(body), headers: token ? { authorization: 'Bearer ' + token } : {},
  }));
  assert.equal((await post(sample(Date.now(), 1))).status, 401);
  assert.equal((await post(sample(Date.now(), 1), 'y'.repeat(40))).status, 401);
  assert.equal((await post({ t: Date.now() }, 'x'.repeat(40))).status, 400);
  assert.equal((await post(sample(Date.now() - 300_000, 1), 'x'.repeat(40))).status, 200);
  assert.equal((await post(sample(Date.now(), 2, { folders: [{ path: '/var', bytes: 5e9 }] }), 'x'.repeat(40))).status, 200);
  const r = await opsReport();
  assert.equal(r.host, 'relay-vm');
  assert.equal(r.recent.length, 1);
  assert.equal(r.folders.rows[0].path, '/var');
  process.env.OPS_USERS = 'a@tu-sofia.bg, B@tu-sofia.bg';
  assert.ok(opsViewer('b@tu-sofia.bg'));
  assert.ok(!opsViewer('c@tu-sofia.bg'));
  delete process.env.OPS_USERS;
  assert.ok(!opsViewer('a@tu-sofia.bg'));
});

test('usage is grouped per project, with disk from /srv, /opt and Docker volumes', async () => {
  const { projects } = await import('../lib/ops.mjs');
  const { projectFor } = await import('../ops/collector.mjs');
  assert.equal(projectFor('kampus-relay'), 'kampus-posta');
  assert.equal(projectFor('snap.oracle-cloud-agent.oracle-cloud-agent'), 'oracle-agents');
  assert.equal(projectFor('signal', 'ExecStart=/srv/signaldonikude-ops/node/bin/node /srv/signaldonikude/app.mjs'), 'signaldonikude');
  assert.equal(projectFor('cron', 'ExecStart=/usr/sbin/cron'), 'system');
  const rows = projects({ cpus: 2, services: [
    { name: 'outreachos-mongo-1', project: 'outreachos', memory: 150e6, cache: 240e6, cpu: 4 },
    { name: 'outreachos-backend-1', project: 'outreachos', memory: 80e6, cache: 0, cpu: 2 },
    { name: 'kampus-relay', project: 'kampus-posta', memory: 25e6, cache: 0, cpu: 1 },
  ] }, { rows: [
    { path: '/opt/kampus-relay', bytes: 1e6 }, { path: '/srv/outreachos', bytes: 1e7 },
    { path: '/var/lib/docker/volumes/outreachos_mongo_data', bytes: 5e8 }, { path: '/var/log', bytes: 3e8 },
  ] });
  assert.deepEqual(rows.map(r => [r.project, r.memory, r.cpu, r.disk, r.units]), [
    ['outreachos', 230e6, 3, 5.1e8, 2],
    ['kampus-posta', 25e6, 0.5, 1e6, 1],
  ]);
});

test('the VM can send an hour of samples in one request, in any order, without double-counting', async () => {
  const post = body => ingest(new Request('http://x/api/ops', {
    method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer ' + 'x'.repeat(40) },
  }));
  const before = await opsReport();
  const base = before.updated + 1; // samples newer than what is stored, 61 s apart
  const batch = Array.from({ length: 4 }, (_, i) => sample(base + i * 61_000, 100 + i));
  assert.equal((await post({ samples: [...batch].reverse() })).status, 200);
  // The first sample only bridges from the stored one (under 60 s apart); the other three become points.
  assert.equal((await opsReport()).recent.length, before.recent.length + 3);
  assert.equal((await post({ samples: batch })).status, 200); // a resend changes nothing
  assert.equal((await opsReport()).recent.length, before.recent.length + 3);
  assert.equal((await post({ samples: [{ t: Date.now() }] })).status, 400);
  assert.equal((await post({ samples: Array.from({ length: 31 }, () => batch[0]) })).status, 400);
});
