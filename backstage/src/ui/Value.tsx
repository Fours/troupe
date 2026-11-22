// A wire value, drawn as indented JSON, with the encoder's markers as labelled chips and, on the
// timeline, what changed since the event before highlighted and what went struck through.

import type { WireValue } from '@kylewillett/troupe/backstage';
import type { ReactNode } from 'react';
import { NO_DIFF, segment, type Diff, type Pointer } from '../store/diff.ts';
import { describeMarker, isMarkerKey, unescapeKey } from './format.ts';

const MARKER_KIND: Readonly<Record<string, string>> = {
  $ref: 'ref',
  $error: 'error',
  $value: 'value',
  $cycle: 'cycle',
  $string: 'cut',
  $truncated: 'cut',
};

function markerKind(value: WireValue): string {
  const first = Object.keys(value as object)[0] ?? '';
  return MARKER_KIND[first] ?? 'value';
}

/** Draws `value`. With `diff`, marks what changed and shows what was removed. */
export function Value({ value, diff = NO_DIFF }: { value: WireValue; diff?: Diff }) {
  return (
    <pre className="bs-value">
      <Node value={value} at="" diff={diff} />
    </pre>
  );
}

function Node({ value, at, diff }: { value: WireValue; at: Pointer; diff: Diff }): ReactNode {
  const changed = diff.changed.has(at);
  // A container spans lines, so its highlight is a block around all of them.
  const wrap = (node: ReactNode, block = false) =>
    changed ? (
      <mark className={block ? 'bs-changed bs-block' : 'bs-changed'} title="Changed by this event">
        {node}
      </mark>
    ) : (
      node
    );

  const marker = describeMarker(value);
  if (marker !== undefined) {
    return wrap(<span className={`bs-chip bs-chip-${markerKind(value)}`}>{marker}</span>);
  }
  if (value === null || typeof value !== 'object') {
    const kind = value === null ? 'null' : typeof value;
    return wrap(
      <span className={`bs-${kind}`}>
        {typeof value === 'string' ? `"${value}"` : String(value)}
      </span>,
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, WireValue][] = isArray
    ? (value as readonly WireValue[]).map((v, i) => [String(i), v])
    : Object.entries(value);
  const removed = diff.removed.get(at) ?? [];
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0 && removed.length === 0) return wrap(<span>{`${open}${close}`}</span>);

  return wrap(
    <>
      {open}
      <span className="bs-entries">
        {entries.map(([key, item]) => (
          <span className="bs-entry" key={key}>
            {!isArray && (
              <span className={isMarkerKey(key) ? 'bs-key bs-chip-cut' : 'bs-key'}>
                {unescapeKey(key)}:{' '}
              </span>
            )}
            <Node value={item} at={at + segment(key)} diff={diff} />
          </span>
        ))}
        {removed.map(([key, item]) => (
          <del className="bs-entry bs-removed" key={`removed:${key}`} title="Removed by this event">
            {!isArray && <span className="bs-key">{unescapeKey(key)}: </span>}
            <Node value={item} at={`removed:${at}${segment(key)}`} diff={NO_DIFF} />
          </del>
        ))}
      </span>
      {close}
    </>,
    true,
  );
}
