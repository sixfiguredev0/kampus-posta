// VM usage tracking for the private /ops dashboard. The VM collector (ops/collector.mjs) pushes one sample every
// five minutes; this module folds it into a single sealed record and turns that record into a plain-language report.
// Nothing here can act on the VM: the only input is the sample, the only output is the report.
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, get, put } from './store.mjs';

const hour = 3_600_000;
const day = 24 * hour;
const stateKey = 'ops:state';
const ok = value => Number.isFinite(value) && value >= 0;
const num = value => Math.round(value * 10) / 10;

function validSample(s) {
  return s && ok(s.t) && s.t < Date.now() + 5 * 60_000 && s.t > Date.now() - 3 * hour && typeof s.host === 'string' && s.host.length < 100
    && ['busy', 'idle', 'steal'].every(key => ok(s.cpu?.[key]))
    && ['total', 'available', 'swapTotal', 'swapFree'].every(key => ok(s.mem?.[key]))
    && ok(s.net?.rx) && ok(s.net?.tx) && ok(s.disk?.total) && ok(s.disk?.free) && ok(s.load) && ok(s.uptime)
    && (s.cpus === undefined || (Number.isInteger(s.cpus) && s.cpus > 0 && s.cpus < 512))
    && Array.isArray(s.services) && s.services.length <= 60
    && s.services.every(row => typeof row.name === 'string' && row.name.length < 120 && ok(row.memory) && ok(row.cpu)
      && (row.project === undefined || (typeof row.project === 'string' && row.project.length < 120)) && (row.cache === undefined || ok(row.cache)))
    && (s.folders === undefined || (Array.isArray(s.folders) && s.folders.length <= 60
      && s.folders.every(row => typeof row.path === 'string' && row.path.length < 300 && ok(row.bytes))));
}

// Folds one sample into the stored state. Counters (CPU, network, per-service CPU) only make sense as a difference
// from the previous sample, so the first sample after a reboot or a long gap records the snapshot but no point.
export function applySample(state, s) {
  state ||= { recent: [], hourly: [], folders: [] };
  const prev = state.last;
  const elapsed = prev ? s.t - prev.t : 0;
  const memUsed = s.mem.total - s.mem.available;
  const services = s.services.map(row => {
    const before = prev?.services?.find(item => item.name === row.name);
    const cpu = before && elapsed > 0 && row.cpu >= before.usec ? (row.cpu - before.usec) / (elapsed * 10) : null;
    return { name: row.name, project: row.project || 'system', memory: row.memory, cache: row.cache || 0, cpu: cpu == null ? null : num(cpu), usec: row.cpu };
  });
  if (prev && elapsed >= 60_000 && elapsed <= 30 * 60_000 && s.cpu.busy >= prev.cpu.busy && s.net.rx >= prev.net.rx) {
    const busy = s.cpu.busy - prev.cpu.busy;
    const steal = s.cpu.steal - prev.cpu.steal;
    const total = busy + (s.cpu.idle - prev.cpu.idle) + steal || 1;
    const point = {
      t: s.t,
      cpu: num(100 * busy / total),
      steal: num(100 * steal / total),
      mem: num(100 * memUsed / s.mem.total),
      disk: s.disk.total - s.disk.free,
      rx: Math.round((s.net.rx - prev.net.rx) * 1000 / elapsed),
      tx: Math.round((s.net.tx - prev.net.tx) * 1000 / elapsed),
      load: s.load,
    };
    state.recent = [...state.recent.filter(p => p.t > s.t - 2 * day), point];
    const h = Math.floor(s.t / hour) * hour;
    let bucket = state.hourly.at(-1);
    if (bucket?.h !== h) state.hourly.push(bucket = { h, n: 0, cpu: 0, cpuMax: 0, steal: 0, mem: 0, memMax: 0, rx: 0, tx: 0, disk: 0 });
    bucket.n++;
    bucket.cpu += point.cpu;
    bucket.cpuMax = Math.max(bucket.cpuMax, point.cpu);
    bucket.steal += point.steal;
    bucket.mem += point.mem;
    bucket.memMax = Math.max(bucket.memMax, point.mem);
    bucket.rx += point.rx;
    bucket.tx += point.tx;
    bucket.disk = point.disk;
    state.hourly = state.hourly.filter(b => b.h > s.t - 60 * day);
  }
  if (s.folders?.length) {
    const date = new Date(s.t).toISOString().slice(0, 10);
    state.folders = [...state.folders.filter(f => f.date !== date && f.t > s.t - 35 * day), { date, t: s.t, rows: s.folders }];
  }
  state.last = {
    t: s.t, host: s.host, uptime: s.uptime, cpus: s.cpus || 1, cpu: s.cpu, net: s.net, services,
    mem: s.mem, disk: s.disk,
  };
  return state;
}

const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : null;
const avg = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

// Least-squares slope of disk use over the last 14 days, in bytes per day.
function diskSlope(hourly) {
  const rows = hourly.filter(b => b.disk > 0);
  if (rows.length < 24) return null;
  const xs = rows.map(b => b.h / day), ys = rows.map(b => b.disk);
  const mx = avg(xs), my = avg(ys);
  const den = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return den ? xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / den : null;
}

export function report(state, now = Date.now()) {
  if (!state?.last) return { empty: true };
  const last = state.last;
  const week = state.hourly.filter(b => b.h > now - 7 * day);
  const hours = week.map(b => ({ cpu: b.cpu / b.n, steal: b.steal / b.n, mem: b.mem / b.n, memMax: b.memMax, net: (b.rx + b.tx) / b.n }));
  const slope = diskSlope(state.hourly.filter(b => b.h > now - 14 * day));
  const diskUsed = last.disk.total - last.disk.free;
  const diskPct = 100 * diskUsed / last.disk.total;
  const daysToFull = slope > 0 ? last.disk.free / slope : null;
  const memP95 = p95(hours.map(h => h.memMax));
  const cpuAvg = avg(hours.map(h => h.cpu));
  const cpuP95 = p95(hours.map(h => h.cpu));
  const stealAvg = avg(hours.map(h => h.steal));
  const swapPct = last.mem.swapTotal ? 100 * (last.mem.swapTotal - last.mem.swapFree) / last.mem.swapTotal : 0;
  // Oracle reclaims an Always Free VM whose 7-day 95th percentile CPU and network both stay under 20%.
  // Network is measured against the E2.1.Micro's 50 Mbps, i.e. 20% = 1.25 MB/s.
  const netP95 = p95(hours.map(h => h.net));
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });
  const enough = hours.length >= 24;
  if (memP95 != null) add(memP95 >= 90 ? 'critical' : memP95 >= 75 ? 'warning' : 'good', 'Памет',
    'Пикът (95-ти перцентил) за 7 дни е ' + num(memP95) + '% от ' + gb(last.mem.total) + '.');
  add(diskPct >= 90 || daysToFull < 14 ? 'critical' : diskPct >= 75 || daysToFull < 60 ? 'warning' : 'good', 'Диск',
    num(diskPct) + '% зает (' + gb(diskUsed) + ' от ' + gb(last.disk.total) + ').'
    + (daysToFull ? ' При сегашния темп се пълни след ~' + Math.round(daysToFull) + ' дни.' : slope != null ? ' Не расте.' : ''));
  if (cpuAvg != null) add(cpuAvg >= 70 ? 'critical' : cpuAvg >= 40 ? 'warning' : 'good', 'Процесор',
    'Средно ' + num(cpuAvg) + '%, пик ' + num(cpuP95) + '% за 7 дни.');
  if (stealAvg != null) add(stealAvg >= 40 ? 'critical' : stealAvg >= 15 ? 'warning' : 'good', 'Отнето време (steal)',
    'Средно ' + num(stealAvg) + '% от процесора отива при други машини на Oracle. Високо значение значи бавна машина.');
  if (swapPct > 25) add(swapPct > 60 ? 'critical' : 'warning', 'Swap', num(swapPct) + '% от swap се ползва: паметта не стига.');
  if (enough && cpuP95 < 20 && netP95 < 1_250_000) add('warning', 'Риск Oracle да я спре',
    'CPU и мрежата са под 20% за 7 дни. Oracle може да прибере безплатна VM, която изглежда неактивна.');
  const worst = checks.some(c => c.level === 'critical') ? 'critical' : checks.some(c => c.level === 'warning') ? 'warning' : 'good';
  const verdict = !enough ? 'Още се събират данни (нужни са поне 24 часа за тенденции).'
    : worst === 'critical' ? 'Да, време е за втори сървър или по-голяма машина.'
    : worst === 'warning' ? 'Още не, но следете отбелязаното по-долу.'
    : 'Не. Има място за още услуги.';
  const folders = state.folders.at(-1);
  const weekAgo = state.folders.find(f => f.t <= (folders?.t ?? now) - 6 * day) || state.folders[0];
  return {
    host: last.host, updated: last.t, uptime: last.uptime, stale: now - last.t > 75 * 60_000,
    verdict, level: enough ? worst : 'collecting', checks,
    memTotal: last.mem.total, diskTotal: last.disk.total, diskUsed, daysToFull: daysToFull && Math.round(daysToFull),
    recent: state.recent,
    hourly: state.hourly.map(b => ({ t: b.h, cpu: num(b.cpu / b.n), cpuMax: b.cpuMax, steal: num(b.steal / b.n), mem: num(b.mem / b.n), memMax: b.memMax, disk: b.disk, net: Math.round((b.rx + b.tx) / b.n) })),
    cpus: last.cpus,
    services: last.services.map(({ name, project, memory, cache, cpu }) => ({ name, project, memory, cache, cpu })),
    projects: projects(last, folders),
    folders: folders && {
      date: folders.date, since: weekAgo !== folders ? weekAgo?.date : null,
      rows: folders.rows.map(row => ({ ...row, growth: weekAgo !== folders ? row.bytes - (weekAgo?.rows.find(r => r.path === row.path)?.bytes ?? 0) : null })),
    },
  };
}

// Per-project totals: memory and CPU from its services/containers, disk from its /srv, /opt or Docker volume folders.
export function projects(last, folders) {
  const map = new Map();
  const entry = name => map.get(name) || map.set(name, { project: name, memory: 0, cache: 0, cpu: 0, disk: 0, units: 0 }).get(name);
  for (const row of last.services) {
    const p = entry(row.project || 'system');
    p.memory += row.memory;
    p.cache += row.cache || 0;
    p.cpu += row.cpu || 0;
    p.units++;
  }
  for (const row of folders?.rows || []) {
    const owner = row.path.match(/^\/(?:srv|opt)\/([\w.-]+)$/)?.[1]
      || row.path.match(/^\/var\/lib\/docker\/volumes\/([\w.-]+?)_/)?.[1];
    // Folder names follow the same naming as units: kampus-relay, kampus-ops, kampus-push all belong to kampus-posta.
    if (owner) entry(owner.startsWith('kampus-') ? 'kampus-posta' : owner).disk += row.bytes;
  }
  return [...map.values()].map(p => ({ ...p, cpu: num(p.cpu / (last.cpus || 1)) })).sort((a, b) => b.memory - a.memory || b.disk - a.disk);
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 2 : 1) + ' GB';
}

function tokenMatches(header) {
  const expected = process.env.OPS_INGEST_TOKEN;
  if (!expected || expected.length < 32 || !header?.startsWith('Bearer ')) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
}

export async function ingest(request) {
  const reply = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (config() === 'off' || !process.env.OPS_INGEST_TOKEN) return reply({ error: 'ops_disabled' }, 503);
  if (!tokenMatches(request.headers.get('authorization'))) return reply({ error: 'unauthorized' }, 401);
  if (Number(request.headers.get('content-length')) > 400_000) return reply({ error: 'too_large' }, 413);
  const body = await request.json().catch(() => null);
  // The VM sends an hour of samples at once; a single sample is still accepted.
  const samples = Array.isArray(body?.samples) ? body.samples : [body];
  if (!samples.length || samples.length > 30 || !samples.every(validSample)) return reply({ error: 'invalid_sample' }, 400);
  let state = await get(stateKey);
  for (const sample of samples.sort((a, b) => a.t - b.t)) {
    if (!state?.last || sample.t > state.last.t) state = applySample(state, sample);
  }
  await put(stateKey, state);
  return reply({ ok: true, samples: samples.length }, 200);
}

// Who may open /ops: a comma-separated list of TU addresses in OPS_USERS. Unset means nobody.
export function opsViewer(user) {
  return (process.env.OPS_USERS || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean).includes(user);
}

export async function opsReport() {
  return report(await get(stateKey));
}
