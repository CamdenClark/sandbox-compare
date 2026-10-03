import { aggregate, DEFAULT_SETTINGS, nextScheduledTime, type Report, type Sample, type Settings } from '../src/shared';
interface ReportRow { id: string; started_at: string; finished_at: string | null; status: Report['status']; trigger: Report['trigger']; settings_json: string; expected_samples: number; error: string | null }
export interface Control { settings_json: string; next_run_at: number; active_run: string | null; lease_until: number | null }
export async function control(env: Env): Promise<Control> {
  await env.DB.prepare('INSERT OR IGNORE INTO control (id, settings_json, next_run_at) VALUES (1, ?, ?)').bind(JSON.stringify(DEFAULT_SETTINGS), nextScheduledTime(Date.now(), DEFAULT_SETTINGS.intervalHours)).run();
  const row = await env.DB.prepare('SELECT * FROM control WHERE id = 1').first<Control>();
  if (!row) throw new Error('Benchmark settings unavailable.');
  return row;
}
export async function getReports(env: Env, id?: string): Promise<Report[]> {
  const rows = id
    ? await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).all<ReportRow>()
    : await env.DB.prepare('SELECT * FROM reports ORDER BY started_at DESC LIMIT 60').all<ReportRow>();
  if (!rows.results.length) return [];
  const ids = rows.results.map(r => r.id);
  const data = await env.DB.prepare(`SELECT report_id, data_json FROM samples WHERE report_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ report_id: string; data_json: string }>();
  return rows.results.map(row => {
    const settings: Settings = JSON.parse(row.settings_json);
    const samples: Sample[] = data.results.filter(s => s.report_id === row.id).map(s => JSON.parse(s.data_json)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status, trigger: row.trigger,
      settings, expectedSamples: row.expected_samples, error: row.error, samples, aggregates: aggregate(samples, settings.scenarios) };
  });
}
export async function saveSample(env: Env, sample: Sample): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO samples (id, report_id, data_json) VALUES (?, ?, ?)').bind(sample.id, sample.reportId, JSON.stringify(sample)).run();
}
export async function finishReport(env: Env, id: string, status: Report['status'], error: string | null = null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE reports SET status = ?, finished_at = ?, error = ? WHERE id = ?').bind(status, new Date().toISOString(), error, id),
    env.DB.prepare('UPDATE control SET active_run = NULL, lease_until = NULL WHERE active_run = ?').bind(id),
  ]);
}
