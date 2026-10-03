import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const local = parseEnv(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'));
const secrets = {};
for (const key of ['DAYTONA_API_KEY', 'ADMIN_TOKEN']) {
  if (!local[key]) throw new Error(`Set ${key} in .dev.vars first.`);
  secrets[key] = local[key];
}
const cli = fileURLToPath(new URL('./cloudflare.mjs', import.meta.url));
const child = spawn(process.execPath, [cli, 'secret', 'bulk'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(JSON.stringify(secrets));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
