// The write-up's charts, drawn as SVG at the width they're shown, so text stays its real size on
// a phone. One form covers them all: a row per scenario, with its median and a whisker from the
// lowest run to the highest. On a linear scale the median is a bar from zero; on a log scale it's
// a dot, since a bar's length means nothing there. The color is one role from writeup.css,
// checked for contrast on both surfaces. A row shown only for comparison, such as a setting that
// doesn't ship, is drawn hollow and says so in its label, so it never relies on color. Every
// chart sits in a Figure with its numbers in a table, so a tooltip is never the only way to a
// value.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Stat } from './data.ts';

export interface ChartRow {
  readonly label: string;
  readonly stat: Stat;
  /** Drawn hollow: a row shown for comparison, not one that ships. */
  readonly comparison?: boolean;
}

function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

/** A bar from the baseline at x0 to x1, its data end rounded and its base square. */
function barPath(x0: number, x1: number, y: number, h: number): string {
  const r = Math.min(4, h / 2, Math.max(0, x1 - x0));
  return ['M', x0, y, 'H', x1 - r, 'A', r, r, 0, 0, 1, x1, y + r, 'V', y + h - r]
    .concat(['A', r, r, 0, 0, 1, x1 - r, y + h, 'H', x0, 'Z'])
    .join(' ');
}

/** A power of ten as an axis label: 1k, 10k, 1M. */
function decadeLabel(n: number): string {
  return n >= 1e6 ? `${String(n / 1e6)}M` : n >= 1e3 ? `${String(n / 1e3)}k` : String(n);
}

/** Powers of ten from below `min` to above `max`, for a log axis. */
function decades(min: number, max: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e += 1) {
    out.push(10 ** e);
  }
  return out;
}

interface Tip {
  readonly x: number;
  readonly y: number;
  readonly row: ChartRow;
}

/** Rows of medians with min–max whiskers, on a linear or log scale. */
export function RangeChart({
  rows,
  format,
  scale = 'linear',
  label,
}: {
  rows: readonly ChartRow[];
  format: (n: number) => string;
  scale?: 'linear' | 'log';
  /** What the chart shows, for screen readers. */
  label: string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  // Narrow screens put each label above its bar rather than beside it.
  const stacked = width < 560;
  const labelWidth = stacked ? 0 : 220;
  const bar = 16;
  const labelRow = stacked ? 20 : 0;
  const band = labelRow + bar + 16;
  const axisHeight = scale === 'log' ? 22 : 0;
  const top = 4;
  const height = top + rows.length * band + axisHeight;
  const valueRoom = 78;
  const plotWidth = Math.max(40, width - labelWidth - valueRoom);
  const highest = Math.max(...rows.map((r) => r.stat.max));
  const lowest = Math.min(...rows.map((r) => r.stat.min));
  const ticks = scale === 'log' ? decades(lowest, highest) : [];
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? highest;
  const x =
    scale === 'log'
      ? (v: number) => labelWidth + (Math.log10(v / lo) / Math.log10(hi / lo)) * plotWidth
      : (v: number) => labelWidth + (v / highest) * plotWidth;
  const plotBottom = top + rows.length * band - 8;

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="grid"
              x1={x(t)}
              x2={x(t)}
              y1={top}
              y2={plotBottom}
              shapeRendering="crispEdges"
            />
            <text className="axis-label" x={x(t)} y={plotBottom + 16} textAnchor="middle">
              {decadeLabel(t)}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const y0 = top + i * band;
          const y = y0 + labelRow;
          const mid = y + bar / 2;
          const { median, min, max } = row.stat;
          const hollow = row.comparison === true;
          const show = (e: { clientX: number; clientY: number }) => {
            const box = ref.current?.getBoundingClientRect();
            if (box !== undefined) setTip({ x: e.clientX - box.left, y: e.clientY - box.top, row });
          };
          return (
            <g
              key={row.label}
              className="chart-row"
              onPointerMove={show}
              onPointerLeave={() => {
                setTip(null);
              }}
            >
              <rect className="hit" x={0} y={y0} width={width} height={band} fill="transparent" />
              <text
                className="axis-label"
                x={stacked ? 0 : labelWidth - 10}
                y={stacked ? y0 + 13 : mid + 4}
                textAnchor={stacked ? 'start' : 'end'}
              >
                {row.label}
              </text>
              {scale === 'linear' ? (
                <line
                  className="baseline"
                  x1={x(0)}
                  x2={x(0)}
                  y1={y - 3}
                  y2={y + bar + 3}
                  shapeRendering="crispEdges"
                />
              ) : null}
              {scale === 'linear' ? (
                <path
                  className={hollow ? 'mark hollow' : 'mark'}
                  d={barPath(x(0), x(median), y + (hollow ? 1 : 0), bar - (hollow ? 2 : 0))}
                />
              ) : null}
              <line className="whisker" x1={x(min)} x2={x(max)} y1={mid} y2={mid} />
              <line className="whisker" x1={x(min)} x2={x(min)} y1={mid - 4} y2={mid + 4} />
              <line className="whisker" x1={x(max)} x2={x(max)} y1={mid - 4} y2={mid + 4} />
              {scale === 'log' ? (
                <circle className={hollow ? 'mark hollow' : 'mark'} cx={x(median)} cy={mid} r={5} />
              ) : null}
              <text className="value-label" x={x(max) + 8} y={mid + 4}>
                {format(median)}
              </text>
            </g>
          );
        })}
      </svg>
      {tip !== null && (
        <div
          className="chart-tip"
          style={{
            left: tip.x > width - 200 ? tip.x - 12 : tip.x + 12,
            top: tip.y,
            transform: tip.x > width - 200 ? 'translateX(-100%)' : undefined,
          }}
          aria-hidden="true"
        >
          <div className="chart-tip-title">{tip.row.label}</div>
          <div>
            Median <strong>{format(tip.row.stat.median)}</strong>
          </div>
          <div>
            Runs {format(tip.row.stat.min)} to {format(tip.row.stat.max)}
          </div>
        </div>
      )}
    </div>
  );
}

/** A cell is a value, or a value with a note under it, such as a median and its range. */
export type Cell = string | readonly [value: string, note: string];

export interface FigureTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly [string, ...Cell[]])[];
}

/** A chart with its title, what it shows, its numbers as a table, and where they come from. */
export function Figure({
  id,
  title,
  description,
  table,
  source,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  table: FigureTable;
  source: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="wu-figure" aria-labelledby={`${id}-title`} data-figure={id}>
      <h3 id={`${id}-title`} className="wu-figure-title">
        {title}
      </h3>
      <p className="wu-figure-desc">{description}</p>
      {children}
      <details className="wu-numbers">
        <summary>Show the numbers</summary>
        <div className="wu-table-wrap">
          <table>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r[0]}>
                  <th scope="row">{r[0]}</th>
                  {r.slice(1).map((cell, i) => (
                    <td key={i}>
                      {typeof cell === 'string' ? (
                        cell
                      ) : (
                        <>
                          {cell[0]}
                          <span className="note">{cell[1]}</span>
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <figcaption className="wu-source">{source}</figcaption>
    </figure>
  );
}
