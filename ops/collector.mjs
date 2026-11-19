// Read-only usage sampler for the VM. Runs once per systemd timer tick, reads /proc, /sys, unit files, Docker
// container metadata on disk and folder sizes, and POSTs one JSON sample to the Кампус Поща ops endpoint.
// It opens no port, never talks to the Docker socket and changes nothing on the machine.
import { execFile } from 'node:child_process';
import { readdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

const read = path => readFile(path, 'utf8').catch(() => '');

export function parseStat(text) {
  // cpu  user nice system idle iowait irq softirq steal
  const [user, nice, system, idle, iowait, irq, softirq, steal] = text.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return { busy: user + nice + system + irq + softirq, idle: idle + iowait, steal, iowait };
}

export function parseMeminfo(text) {
  const kb = name => Number(text.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))?.[1] || 0) * 1024;
  return { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

export function parseNetDev(text) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, data] = line.split(':');
    if (!data || name.trim() === 'lo' || /^(docker|br-|veth)/.test(name.trim())) continue;
    const fields = data.trim().split(/\s+/).map(Number);
    rx += fields[0];
    tx += fields[8];
  }
  return { rx, tx };
}

// Which project a unit belongs to: Kampus units, Oracle's own agents and the container runtime by name; otherwise
// the last /srv or /opt path in its unit file (the script, not the interpreter); otherwise "system".
const projectRules = [
  [/^kampus-/, 'kampus-posta'],
  [/^(snap\.oracle-cloud-agent|unified-monitoring-agent|iscsid)/, 'oracle-agents'],
  [/^(docker|containerd)$/, 'docker'],
];
export function projectFor(name, unitText = '') {
  const rule = projectRules.find(([pattern]) => pattern.test(name));
  if (rule) return rule[1];
  const paths = [...unitText.matchAll(/\/(?:srv|opt)\/([\w.-]+)/g)].map(match => match[1]);
  return paths.at(-1) || 'system';
}

async function cgroupRow(dir, name, project) {
  const stat = await read(dir + '/memory.stat');
  const field = key => Number(stat.match(new RegExp('^' + key + ' (\\d+)', 'm'))?.[1] || 0);
  return {
    name, project,
    memory: field('anon') + field('shmem'), // what the processes hold; reclaimable page cache is separate
    cache: field('file'),
    cpu: Number((await read(dir + '/cpu.stat')).match(/usage_usec (\d+)/)?.[1] || 0),
  };
}

// Every systemd service and Docker container, plus all login sessions together, each tagged with its project.
async function units() {
  const root = '/sys/fs/cgroup/system.slice/';
  const entries = await readdir(root).catch(() => []);
  const rows = await Promise.all(entries.map(async entry => {
    if (entry.endsWith('.service')) {
      const name = entry.slice(0, -8);
      const unitText = await read('/etc/systemd/system/' + entry) || await read('/lib/systemd/system/' + entry);
      return cgroupRow(root + entry, name, projectFor(name, unitText));
    }
    const id = entry.match(/^docker-([0-9a-f]{64})\.scope$/)?.[1];
    if (!id) return null;
    // Container metadata is read from disk: the Docker socket would give this sampler root-equivalent power.
    let container = {};
    try { container = JSON.parse(await read('/var/lib/docker/containers/' + id + '/config.v2.json')); } catch {}
    const name = (container.Name || id.slice(0, 12)).replace(/^\//, '');
    return cgroupRow(root + entry, name, container.Config?.Labels?.['com.docker.compose.project'] || name);
  }));
  rows.push(await cgroupRow('/sys/fs/cgroup/user.slice', 'login sessions', 'ssh-sessions'));
  return rows.filter(row => row && (row.memory > 0 || row.cpu > 0)).sort((a, b) => b.memory - a.memory).slice(0, 50);
}

function du(args) {
  return new Promise(resolve => {
    execFile('du', ['-x', '-B1', ...args], { maxBuffer: 8 << 20, timeout: 120_000 }, (error, stdout) => {
      resolve((stdout || '').trim().split('\n').map(line => {
        const [bytes, path] = line.split('\t');
        return { path, bytes: Number(bytes) };
      }).filter(row => row.path && row.bytes > 0));
    });
  });
}

// Two levels of / plus each Docker volume, so a container's database counts toward its project. Hourly only.
async function folders() {
  const [tree, docker, volumes] = await Promise.all([
    du(['-d', '2', '/']), du(['-d', '1', '/var/lib/docker']), du(['-d', '1', '/var/lib/docker/volumes'])]);
  const top = (rows, skip, count) => rows.filter(row => row.path !== skip).sort((a, b) => b.bytes - a.bytes).slice(0, count);
  return [...top(tree, '/', 25), ...top(docker, '/var/lib/docker', 6), ...top(volumes, '/var/lib/docker/volumes', 12)];
}

async function sample() {
  const [stat, mem, net, loadavg, uptime, cpuinfo, fs, top] = await Promise.all([
    read('/proc/stat'), read('/proc/meminfo'), read('/proc/net/dev'), read('/proc/loadavg'), read('/proc/uptime'),
    read('/proc/cpuinfo'), statfs('/'), units(),
  ]);
  return {
    t: Date.now(),
    host: hostname(),
    uptime: Math.round(Number(uptime.split(' ')[0])),
    load: Number(loadavg.split(' ')[0]),
    cpus: cpuinfo.match(/^processor/gm)?.length || 1,
    cpu: parseStat(stat),
    mem: parseMeminfo(mem),
    net: parseNetDev(net),
    disk: { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize },
    services: top,
    folders: new Date().getUTCMinutes() < 5 || process.env.OPS_FOLDERS_NOW ? await folders() : undefined,
  };
}

// Samples queue on the VM and go out once an hour (with the folder sizes). Posting every 5 minutes would keep the
// free Neon database awake around the clock and use up its monthly compute in about two weeks.
const queueFile = (process.env.STATE_DIRECTORY || '/var/lib/kampus-ops') + '/queue.json';
const maxQueue = 24;

if (import.meta.url === 'file://' + process.argv[1]) {
  const current = await sample();
  if (process.env.OPS_DRY_RUN) {
    console.log(JSON.stringify(current));
  } else {
    let queue = [];
    try { queue = JSON.parse(await readFile(queueFile, 'utf8')); } catch {}
    queue = [...queue, current].slice(-maxQueue);
    if (current.folders || queue.length > 13 || process.env.OPS_SEND_NOW) {
      const response = await fetch(process.env.OPS_INGEST_URL, {
        method: 'POST', body: JSON.stringify({ samples: queue }), signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPS_INGEST_TOKEN },
      }).catch(error => ({ ok: false, status: 0, text: async () => error.message }));
      if (response.ok) queue = [];
      else console.error('ingest failed, keeping', queue.length, 'samples:', response.status, await response.text());
    }
    await writeFile(queueFile, JSON.stringify(queue));
  }
}
