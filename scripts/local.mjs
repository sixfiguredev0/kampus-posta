import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = process.argv[2] === 'start' ? 'start' : 'dev';
const server = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)),
  command, '--hostname', '127.0.0.1', '--port', process.env.PORT === '3001' ? '3001' : '3000',
], { stdio: 'inherit', env: { ...process.env, MAIL_MODE: process.env.MAIL_MODE || 'local' } });

server.on('exit', code => { process.exitCode = code ?? 1; });
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
