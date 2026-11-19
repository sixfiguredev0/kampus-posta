'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Clock, RefreshCw } from 'lucide-react';

const levels = {
  good: { icon: CheckCircle2, text: 'Наред' },
  warning: { icon: AlertTriangle, text: 'Внимание' },
  critical: { icon: CircleAlert, text: 'Проблем' },
  collecting: { icon: Clock, text: 'Събиране' },
};

const bytes = value => value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' MB' : Math.round(value / 1024) + ' KB';
const rate = value => bytes(value) + '/s';
const pct = value => value.toFixed(1) + '%';
const when = t => new Date(t).toLocaleString('bg-BG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Chart({ title, rows, field, format, max, cap }) {
  const [hover, setHover] = useState(null);
  const points = rows.filter(row => Number.isFinite(row[field]));
  if (points.length < 2) return <section className="ops-chart"><h3>{title}</h3><p className="ops-muted">Още няма достатъчно точки.</p></section>;
  const W = 600, H = 140, P = 4;
  const t0 = points[0].t, t1 = points.at(-1).t;
  // Fixed scale when given (disk vs. its size); otherwise fit the data so small values stay readable.
  const top = max ?? (Math.min(cap ?? Infinity, Math.max(...points.map(p => p[field])) * 1.15) || 1);
  const x = t => P + (W - 2 * P) * (t - t0) / (t1 - t0 || 1);
  const y = v => H - P - (H - 2 * P) * Math.min(v, top) / top;
  const line = points.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p[field]).toFixed(1)).join(' ');
  const current = points.at(-1)[field];
  const move = event => {
    const box = event.currentTarget.getBoundingClientRect();
    const t = t0 + (t1 - t0) * (event.clientX - box.left) / box.width;
    setHover(points.reduce((best, p) => Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));
  };
  const shown = hover || points.at(-1);
  return <section className="ops-chart">
    <h3>{title} <span>{format(current)}</span></h3>
    <div className="ops-plot" onPointerMove={move} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title + ', сега ' + format(current)}>
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} className="ops-axis" />
        <line x1={P} x2={W - P} y1={y(top / 2)} y2={y(top / 2)} className="ops-grid" />
        <path d={line + ` L${x(t1)} ${H - P} L${x(t0)} ${H - P} Z`} className="ops-area" />
        <path d={line} className="ops-line" vectorEffect="non-scaling-stroke" />
        {hover && <line x1={x(hover.t)} x2={x(hover.t)} y1={P} y2={H - P} className="ops-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover && <div className="ops-tip" style={{ left: `clamp(0px, calc(${100 * (x(hover.t) / W)}% - 60px), calc(100% - 120px))` }}>
        <strong>{format(shown[field])}</strong><span>{when(shown.t)}</span>
      </div>}
    </div>
    <div className="ops-range"><span>{when(t0)}</span><span>скала до {format(top)}</span><span>{when(t1)}</span></div>
  </section>;
}

function Bars({ rows, value, label, format, extra }) {
  const top = Math.max(...rows.map(value), 1);
  return <ul className="ops-bars">
    {rows.map(row => <li key={label(row)}>
      <span className="ops-bar-label" title={label(row)}>{label(row)}</span>
      <span className="ops-bar-track"><i style={{ width: Math.max(1, 100 * value(row) / top) + '%' }} /></span>
      <span className="ops-bar-value">{format(value(row))}{extra?.(row)}</span>
    </li>)}
  </ul>;
}

export default function OpsDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState('48h');
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/mail/ops', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error || 'service_unavailable'), { status: response.status });
      setData(body);
      setError('');
    } catch (failure) {
      setError(failure.status === 401 ? 'signin' : failure.status === 403 ? 'denied' : 'down');
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error === 'signin') return <main className="ops"><p className="ops-note">Влезте в <a href="/mail">Кампус Поща</a> със своя адрес в ТУ, после отворете тази страница отново.</p></main>;
  if (error === 'denied') return <main className="ops"><p className="ops-note">Този акаунт няма достъп до таблото.</p></main>;
  if (!data) return <main className="ops"><p className="ops-note">{error ? 'Таблото не отговаря. Опитайте пак след малко.' : 'Зареждане…'}</p></main>;
  if (data.empty) return <main className="ops"><p className="ops-note">Още няма данни от сървъра. Първата точка идва до 5 минути след пускане на събирача.</p></main>;

  const rows = range === '48h' ? data.recent : data.hourly;
  const level = levels[data.level];
  const LevelIcon = level.icon;
  return <main className="ops">
    <header className="ops-head">
      <div>
        <h1>Сървър <span>{data.host}</span></h1>
        <p className="ops-muted">Последна точка {when(data.updated)} · работи от {Math.floor(data.uptime / 86400)} дни{data.stale && <strong className="ops-stale"> · няма нови данни над час (данните идват веднъж на час).</strong>}</p>
      </div>
      <button type="button" className="quiet-button" onClick={load}><RefreshCw size={15} /> Обнови</button>
    </header>

    <section className={'ops-verdict is-' + data.level}>
      <LevelIcon size={22} aria-hidden="true" />
      <div><span className="ops-kicker">Нужен ли е втори сървър? · {level.text}</span><strong>{data.verdict}</strong></div>
    </section>

    <ul className="ops-checks">
      {data.checks.map(check => {
        const Icon = levels[check.level].icon;
        return <li key={check.label} className={'is-' + check.level}>
          <Icon size={17} aria-hidden="true" /><div><strong>{check.label} <em>{levels[check.level].text}</em></strong><span>{check.detail}</span></div>
        </li>;
      })}
    </ul>

    <div className="ops-toolbar" role="group" aria-label="Период">
      {[['48h', 'Последни 48 часа'], ['60d', 'По часове, до 60 дни']].map(([key, text]) =>
        <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>{text}</button>)}
    </div>

    {data.projects?.length > 0 && <section className="ops-panel ops-projects">
      <h2>По проекти</h2>
      <p className="ops-muted">Кой проект колко ползва сега. Памет: това, което процесите държат (без кеша на диска, който системата освобождава при нужда). Процесор: % от цялата машина ({data.cpus} ядра), за последните 5 минути. Диск: папките на проекта в /srv, /opt и томовете му в Docker.</p>
      <div className="ops-table-wrap"><table className="ops-table">
        <thead><tr><th scope="col">Проект</th><th scope="col">Памет</th><th scope="col">Кеш</th><th scope="col">Процесор</th><th scope="col">Диск</th></tr></thead>
        <tbody>{data.projects.map(p => <tr key={p.project}>
          <th scope="row">{p.project}<small>{p.units} {p.units === 1 ? 'услуга' : 'услуги'}</small></th>
          <td><span className="ops-cell-bar"><i style={{ width: 100 * p.memory / data.memTotal + '%' }} /></span>{bytes(p.memory)}</td>
          <td className="ops-dim">{bytes(p.cache)}</td>
          <td>{pct(p.cpu)}</td>
          <td>{p.disk ? bytes(p.disk) : '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    <div className="ops-grid-charts">
      <Chart title="Процесор" rows={rows} field="cpu" format={pct} cap={100} />
      <Chart title="Отнето време (steal)" rows={rows} field="steal" format={pct} cap={100} />
      <Chart title="Памет" rows={rows} field="mem" format={pct} cap={100} />
      <Chart title="Диск, заето" rows={rows} field="disk" format={bytes} max={data.diskTotal} />
      <Chart title="Мрежа (вход + изход)" rows={rows.map(r => ({ ...r, net: r.net ?? (r.rx + r.tx) }))} field="net" format={rate} />
    </div>

    <section className="ops-panel">
      <h2>Какво държи паметта</h2>
      <p className="ops-muted">Всяка услуга и всеки Docker контейнер, по използвана памет. Процесорът е за последните 5 минути, % от едно ядро.</p>
      <Bars rows={data.services} value={row => row.memory} label={row => row.name + (row.project && row.project !== row.name ? ' · ' + row.project : '')} format={bytes}
        extra={row => row.cpu != null && <small> · {pct(row.cpu)} CPU</small>} />
    </section>

    <section className="ops-panel">
      <h2>Какво заема място</h2>
      {data.folders
        ? <>
          <p className="ops-muted">Най-големите папки (две нива), измерени на {data.folders.date}.{data.folders.since ? ' Промяната е спрямо ' + data.folders.since + '.' : ' Промяната ще се вижда след няколко дни.'}</p>
          <Bars rows={data.folders.rows.slice(0, 15)} value={row => row.bytes} label={row => row.path} format={bytes}
            extra={row => row.growth ? <small className={row.growth > 0 ? 'ops-up' : ''}> · {row.growth > 0 ? '+' : '−'}{bytes(Math.abs(row.growth))}</small> : null} />
        </>
        : <p className="ops-muted">Папките се измерват веднъж на час, в първите 5 минути.</p>}
    </section>
  </main>;
}
