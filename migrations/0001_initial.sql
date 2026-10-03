CREATE TABLE IF NOT EXISTS control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  active_run TEXT,
  lease_until INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  expected_samples INTEGER NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id),
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_report ON samples(report_id);
CREATE INDEX IF NOT EXISTS reports_date ON reports(started_at DESC);
