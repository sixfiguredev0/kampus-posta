import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

// Local data is runtime state and must stay out of the deployment trace.
const projectData = resolve(/* turbopackIgnore: true */ process.env.MAIL_DATA_DIRECTORY || '.mail-data');
export const accountId = user => createHash('sha256').update(user.toLowerCase()).digest('hex');
export const sessionHash = id => createHash('sha256').update(id).digest('hex');

export function config() {
  const mode = process.env.MAIL_MODE || 'off';
  if (mode === 'local' && !process.env.VERCEL) return mode;
  if (mode === 'hosted' && process.env.TU_HOSTED_APPROVED === 'yes' && process.env.DATABASE_URL
    && process.env.APP_KEY && process.env.TU_ALLOWED_USERS && process.env.BLOB_READ_WRITE_TOKEN
    && process.env.MAIL_ORIGIN) return mode;
  // Missing or incomplete configuration keeps every mail route switched off.
  return 'off';
}

let keyPromise;
function getKey() {
  keyPromise ||= (async () => {
    if (process.env.APP_KEY) {
      const key = Buffer.from(process.env.APP_KEY, 'base64');
      if (key.length !== 32) throw new Error('APP_KEY must decode to 32 bytes');
      return key;
    }
    if (config() !== 'local') throw new Error('Encryption key missing');
    await mkdir(projectData, { recursive: true });
    const filename = resolve(projectData, 'session.key');
    try {
      await writeFile(filename, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return readFile(filename);
  })();
  return keyPromise;
}

export async function seal(recordKey, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await getKey(), iv);
  cipher.setAAD(Buffer.from(recordKey));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}

export async function unseal(recordKey, value) {
  if (value == null) return null;
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', await getKey(), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(recordKey));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
}

let storage;
async function database() {
  storage ||= (async () => {
    if (config() === 'hosted') {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000 });
      await pool.query('CREATE TABLE IF NOT EXISTS portal_data (key text PRIMARY KEY, value text NOT NULL, expiration bigint NOT NULL)');
      return {
        async get(key, now) {
          const result = await pool.query('SELECT value FROM portal_data WHERE key=$1 AND expiration>$2', [key, now]);
          return result.rows[0]?.value;
        },
        async put(key, value, expiration, kind) {
          if (kind === 'update') {
            return (await pool.query('UPDATE portal_data SET value=$2, expiration=$3 WHERE key=$1', [key, value, expiration])).rowCount > 0;
          }
          // A claim may take over an expired row that the hourly purge has not removed yet.
          const conflict = kind === 'claim' ? ' WHERE portal_data.expiration <= $4' : '';
          return (await pool.query('INSERT INTO portal_data VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expiration=excluded.expiration' + conflict,
            kind === 'claim' ? [key, value, expiration, Date.now()] : [key, value, expiration])).rowCount > 0;
        },
        delete: key => pool.query('DELETE FROM portal_data WHERE key=$1', [key]),
        purge: now => pool.query('DELETE FROM portal_data WHERE expiration <= $1', [now]),
      };
    }
    if (config() !== 'local') throw new Error('Live state unavailable');
    const { DatabaseSync } = await import('node:sqlite');
    await mkdir(projectData, { recursive: true });
    const db = new DatabaseSync(resolve(projectData, 'state.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS portal_data (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiration INTEGER NOT NULL);');
    const get = db.prepare('SELECT value FROM portal_data WHERE key=? AND expiration>?');
    const put = db.prepare('INSERT INTO portal_data VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expiration=excluded.expiration');
    const claim = db.prepare('INSERT INTO portal_data VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expiration=excluded.expiration WHERE portal_data.expiration <= ?');
    const update = db.prepare('UPDATE portal_data SET value=?, expiration=? WHERE key=?');
    const remove = db.prepare('DELETE FROM portal_data WHERE key=?');
    const purge = db.prepare('DELETE FROM portal_data WHERE expiration <= ?');
    return {
      get: (key, now) => get.get(key, now)?.value,
      put: (key, value, expiration, kind) => kind === 'update'
        ? update.run(value, expiration, key).changes > 0
        : kind === 'claim' ? claim.run(key, value, expiration, Date.now()).changes > 0 : put.run(key, value, expiration).changes > 0,
      delete: key => remove.run(key),
      purge: now => purge.run(now),
    };
  })();
  return storage;
}

export async function get(key) {
  return unseal(key, await (await database()).get(key, Date.now()));
}
export async function put(key, value, expiration = 253402300799000, kind) {
  return (await database()).put(key, await seal(key, value), expiration, kind);
}
export async function remove(key) {
  return (await database()).delete(key);
}
let lastPurge = 0;
export async function purgeExpired() {
  const now = Date.now();
  if (now - lastPurge > 3600000) {
    await (await database()).purge(now);
    lastPurge = now;
  }
}
