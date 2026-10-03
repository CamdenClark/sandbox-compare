import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PROVIDER_PRICING, PROVIDERS, type Dashboard, type Report, type Scenario } from './shared';
import './styles.css';

const duration = (value: number | null | undefined) => value == null ? '—' : value >= 1000
  ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const timestamp = (value: string) => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(value));
const providerName = (id: string) => PROVIDERS.find(provider => provider.id === id)?.name ?? id;

function App() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [workloadId, setWorkloadId] = useState('shell');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/dashboard', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Unable to load measurements.');
      setData(await response.json() as Dashboard);
      setError('');
    } catch { setError('Unable to load measurements.'); }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => clearInterval(timer);
  }, [load]);

  // Publish a finished batch; an in-progress batch should not mix incomplete results into the table.
  const latest = data?.reports.find(batch => batch.finishedAt !== null);
  const workloads = latest?.settings.scenarios.filter(workload => workload.enabled) ?? [];
  const workload = workloads.find(item => item.id === workloadId) ?? workloads[0];
  const totalPassed = latest?.samples.filter(sample => sample.status === 'passed').length ?? 0;

  return <>
    <header className="site-header">
      <a href="/" className="site-name">Sandbox Index</a>
      <nav aria-label="Main navigation">
        <a href="#benchmarks">Benchmarks</a>
        <a href="#methodology">Methodology</a>
      </nav>
    </header>

    <main>
      <section className="intro" id="benchmarks">
        <h1>Sandbox startup benchmarks</h1>
        <p>How long it takes to create a sandbox, run a command, and serve an HTTP response.</p>
        {latest && <div className="measurement-meta">
          <span>Updated <time dateTime={latest.finishedAt!}>{timestamp(latest.finishedAt!)}</time></span>
          <span>{data?.settings.enabled ? `Measured every ${data.settings.intervalHours} hours` : 'Automatic measurements paused'}</span>
        </div>}
      </section>

      {error && <p className="load-error" role="alert">{error} <button onClick={() => void load()}>Retry</button></p>}
      {!data && !error && <p className="loading">Loading measurements…</p>}

      {data && <>
        <section className="results" aria-labelledby="results-title">
          <div className="section-heading">
            <h2 id="results-title">Latest measurements</h2>
            {latest && <a href={`/api/reports/${latest.id}.json`}>Download data ↗</a>}
          </div>

          {!latest ? <p className="empty">No measurements have been published yet.</p> : <>
            <div className="table-scroll" tabIndex={0} aria-label="Sandbox startup measurements">
              <table>
                <caption>Median times for {latest.settings.repetitions} fresh instances per workload.</caption>
                <thead><tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Workload</th>
                  <th scope="col">Container</th>
                  <th scope="col" className="number">Create API</th>
                  <th scope="col" className="number">Command ready</th>
                  <th scope="col" className="number">Healthy</th>
                  <th scope="col" className="number">Passed</th>
                </tr></thead>
                <tbody>{latest.aggregates.map(result => {
                  const sample = latest.samples.find(sample => sample.scenarioId === result.scenarioId && sample.sandboxId);
                  return <tr key={result.scenarioId}>
                    <th scope="row" className="provider">{providerName(result.provider)}</th>
                    <td className="workload-cell">{result.scenarioName}</td>
                    <td className="container-cell"><code>{result.source}</code><span>{(sample?.region ?? result.region).replace('provider-default', 'Provider default')}{sample?.resources.cpu != null && sample.resources.memory != null && ` · ${sample.resources.cpu} vCPU · ${sample.resources.memory} GiB`}</span></td>
                    <td className="number create" data-label="Create API">{duration(result.createMedianMs)}</td>
                    <td className="number ready" data-label="Command ready">{duration(result.readyMedianMs)}</td>
                    <td className="number healthy" data-label="Healthy">{duration(result.healthyMedianMs)}</td>
                    <td className="number passed" data-label="Passed">{result.passed}/{result.total}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <p className="table-note">{totalPassed} of {latest.expectedSamples} evaluations passed. Times include network latency from Cloudflare. Failed evaluations are excluded from latency medians.</p>
          </>}
        </section>

        {latest && workload && <section className="history" aria-labelledby="history-title">
          <div className="section-heading">
            <div><h2 id="history-title">Time to healthy</h2><p>Median for each measurement batch with the same workload configuration.</p></div>
            <label className="workload-select">Workload
              <select value={workload.id} onChange={event => setWorkloadId(event.target.value)}>
                {workloads.map(item => <option key={item.id} value={item.id}>{providerName(item.provider)} · {item.name}</option>)}
              </select>
            </label>
          </div>
          <HistoryChart batches={data.reports} workload={workload} />
        </section>}

        <section id="methodology" className="methodology" aria-labelledby="methodology-title">
          <h2 id="methodology-title">Methodology</h2>
          <dl>
            <div><dt>Create API</dt><dd>From the create request to the provider returning a sandbox ID.</dd></div>
            <div><dt>Command ready</dt><dd>From the create request to the first successful shell command with verified output.</dd></div>
            <div><dt>Healthy</dt><dd>From the create request to verified workload output. HTTP servers must return the expected response to a probe inside the sandbox.</dd></div>
          </dl>
          <p>Each evaluation creates a separate sandbox and deletes it afterward. Provider image caches and warm pools may be used. Startup is polled every 200 ms; health checks every 250 ms. These timings include those delays and API latency.</p>
          <p>The same commands run on each provider’s prepared image. CPU and memory come from the provider’s sandbox details and are shown above. E2B assigns its default region; the API does not identify its location. These are comparisons of the listed configurations.</p>
          <p>Results use the median of successful evaluations. An evaluation passes only after workload health and sandbox deletion are confirmed. Each batch currently uses {latest?.settings.repetitions ?? data.settings.repetitions} evaluations per workload; small batches give preliminary results.</p>
        </section>

        {Object.entries(PROVIDER_PRICING).filter(([id]) => latest?.aggregates.some(result => result.provider === id)).map(([id, price]) => <section key={id} className="pricing" aria-labelledby={`${id}-pricing-title`}>
          <div className="section-heading"><h2 id={`${id}-pricing-title`}>{providerName(id)} pricing</h2><a href={price.source} target="_blank" rel="noreferrer">Source ↗</a></div>
          <p className="price-line"><span><strong>${price.cpuHour}</strong> / vCPU-hour</span><span><strong>${price.memoryGiBHour}</strong> / GiB-hour of memory</span><span>{price.diskGiBHour ? <><strong>${price.diskGiBHour}</strong> / GiB-hour of storage</> : 'Storage included'}</span></p>
          <p className="pricing-note">Published rates checked {price.checkedAt}. Billed per second. {price.note}</p>
        </section>)}
      </>}

      <footer><span>Sandbox Index</span>{latest && <span><a href={`/api/reports/${latest.id}.json`}>Measurements (JSON)</a><a href={`/api/reports/${latest.id}.md`}>Methodology and data (Markdown)</a></span>}</footer>
    </main>
  </>;
}

function HistoryChart({ batches, workload }: { batches: Report[]; workload: Scenario }) {
  const points = batches.filter(batch => {
    if (!batch.finishedAt) return false;
    const config = batch.settings.scenarios.find(item => item.id === workload.id);
    return config && JSON.stringify(config) === JSON.stringify(workload);
  }).slice().reverse().flatMap(batch => {
    const result = batch.aggregates.find(item => item.scenarioId === workload.id);
    return result?.healthyMedianMs != null
      ? [{ time: batch.finishedAt!, value: result.healthyMedianMs, count: result.passed }] : [];
  });

  if (!points.length) return <p className="empty">No successful measurements for this workload.</p>;

  const width = 1000, height = 225, left = 64, right = 16, top = 20, bottom = 35;
  const maximum = Math.ceil(Math.max(...points.map(point => point.value), 100) / 100) * 100;
  const times = points.map(point => Date.parse(point.time));
  const first = Math.min(...times), last = Math.max(...times);
  const x = (index: number) => first === last ? (width + left - right) / 2
    : left + (times[index] - first) / (last - first) * (width - left - right);
  const y = (value: number) => top + (1 - value / maximum) * (height - top - bottom);
  const tickDate = (value: string) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return <>
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Median time to healthy for ${workload.name}`}>
        {[0, .25, .5, .75, 1].map(fraction => <g key={fraction}>
          <line x1={left} x2={width-right} y1={y(maximum*fraction)} y2={y(maximum*fraction)} stroke="#e7e7e7" />
          <text x={left-14} y={y(maximum*fraction)+4} textAnchor="end">{duration(maximum*fraction)}</text>
        </g>)}
        <polyline points={points.map((point,index) => `${x(index)},${y(point.value)}`).join(' ')} fill="none" stroke="#27604f" strokeWidth="2" />
        {points.map((point,index) => <g key={point.time}>
          <circle cx={x(index)} cy={y(point.value)} r="4" fill="#27604f"><title>{timestamp(point.time)}: {duration(point.value)}, {point.count} successful evaluations</title></circle>
          {(points.length <= 4 || index % Math.ceil(points.length/4) === 0 || index === points.length-1) && <text x={x(index)} y={height-9} textAnchor={index === 0 && points.length > 1 ? 'start' : index === points.length-1 && points.length > 1 ? 'end' : 'middle'}>{tickDate(point.time)}</text>}
        </g>)}
      </svg>
    </div>
    <p className="chart-note">{providerName(workload.provider)} · {workload.source} · {workload.region.toUpperCase()}</p>
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
