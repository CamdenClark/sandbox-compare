import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:8787';
const secrets = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
if (!secrets.ADMIN_TOKEN) throw new Error('Set ADMIN_TOKEN in .dev.vars first.');
const response = await fetch(new URL('/api/runs', base), { method: 'POST', headers: { Authorization: `Bearer ${secrets.ADMIN_TOKEN}` } });
const result = await response.json();
if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
console.log(`Real evaluation started: ${result.reportId}`);
const deadline = Date.now() + 45 * 60 * 1000;
let previous = -1;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  const response = await fetch(new URL(`/api/reports/${result.reportId}`, base));
  if (!response.ok) throw new Error(`Report polling failed: HTTP ${response.status}`);
  const report = await response.json();
  if (report.samples.length !== previous) {
    previous = report.samples.length;
    console.log(`${report.samples.length}/${report.expectedSamples} samples recorded · ${report.status}`);
  }
  if (!['running', 'queued'].includes(report.status)) {
    await mkdir('artifacts', { recursive: true });
    const output = resolve('artifacts', `report-${report.id}.json`);
    await writeFile(output, JSON.stringify(report, null, 2));
    const markdown = await fetch(new URL(`/api/reports/${report.id}.md`, base));
    await writeFile(output.replace('.json', '.md'), await markdown.text());
    console.log(JSON.stringify({ reportId: report.id, status: report.status, aggregates: report.aggregates, cleanup: report.samples.map(s => ({ workload: s.scenarioName, repetition: s.repetition, status: s.status, cleanup: s.cleanup, error: s.error })), artifact: output }, null, 2));
    process.exit(report.status === 'completed' ? 0 : 1);
  }
}
throw new Error('Report is still running after 45 minutes; inspect Cloudflare Workflows.');
