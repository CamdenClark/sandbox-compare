import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const env = { ...process.env };
if (!env.CLOUDFLARE_API_TOKEN) {
  try {
    const local = parseEnv(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'));
    if (local.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = local.CLOUDFLARE_API_TOKEN;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
