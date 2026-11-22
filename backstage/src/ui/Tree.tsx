// The live tree: one row per actor, each with where it is in its life and how full its mailbox
// is, and a gutter where each message whose sender is known draws a link from sender to
// receiver. Rows have one fixed height, so the gutter can place links without measuring.

import { memo, useMemo, type KeyboardEvent } from 'react';
import type { ActorPhase, ActorView, FlowView } from '../store/store.ts';

/** The height of one row, in px. The CSS uses the same number. */
export const ROW = 30;

/** The width of the message-flow gutter, in px. */
const GUTTER = 28;

const PHASE_WORDS: Readonly<Record<ActorPhase, string>> = {
  starting: 'starting',
  running: 'running',
  restarting: 'restarting',
  stopping: 'stopping',
  stopped: 'stopped',
};

export interface TreeProps {
  readonly actors: readonly ActorView[];
  readonly flows: readonly FlowView[];
  readonly selected: string | undefined;
  /** `open` is true for a click or Enter, which on a phone also shows the actor's details. */
  readonly onSelect: (path: string, open: boolean) => void;
}

/** The actor tree, as a keyboard-navigable ARIA tree. */
export function Tree({ actors, flows, selected, onSelect }: TreeProps) {
  const scale = useMemo(() => Math.max(8, ...actors.map((a) => a.peakDepth)), [actors]);
  const rowOf = useMemo(() => new Map(actors.map((a, i) => [a.path, i])), [actors]);
  const focusable = selected !== undefined && rowOf.has(selected) ? selected : actors[0]?.path;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const index = focusable === undefined ? -1 : (rowOf.get(focusable) ?? -1);
    const go = (i: number) => {
      const next = actors[Math.max(0, Math.min(actors.length - 1, i))];
      if (next === undefined) return;
      e.preventDefault();
      onSelect(next.path, false);
      const row = e.currentTarget.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(next.path)}"]`,
      );
      row?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        go(index + 1);
        return;
      case 'ArrowUp':
        go(index - 1);
        return;
      case 'Home':
        go(0);
        return;
      case 'End':
        go(actors.length - 1);
        return;
      case 'Enter':
      case ' ':
        if (focusable !== undefined) {
          e.preventDefault();
          onSelect(focusable, true);
        }
        return;
    }
  };

  return (
    <div className="bs-tree">
      <svg
        className="bs-flows"
        width={GUTTER}
        height={Math.max(ROW, actors.length * ROW)}
        aria-hidden="true"
      >
        {flows.map((flow) => {
          const from = rowOf.get(flow.from);
          const to = rowOf.get(flow.to);
          if (from === undefined || to === undefined || from === to) return null;
          const y1 = from * ROW + ROW / 2;
          const y2 = to * ROW + ROW / 2;
          const bend = GUTTER - 4 - Math.min(GUTTER - 8, Math.abs(to - from) * 3);
          return (
            <path
              key={flow.id}
              className="bs-flow"
              d={`M ${String(GUTTER)} ${String(y1)} C ${String(bend)} ${String(y1)}, ${String(bend)} ${String(y2)}, ${String(GUTTER)} ${String(y2)}`}
            />
          );
        })}
      </svg>
      <ul role="tree" aria-label="Actors" className="bs-tree-list" onKeyDown={onKeyDown}>
        {actors.map((a) => (
          <Row
            key={a.path}
            actor={a}
            scale={scale}
            selected={a.path === selected}
            focusable={a.path === focusable}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  readonly actor: ActorView;
  readonly scale: number;
  readonly selected: boolean;
  readonly focusable: boolean;
  readonly onSelect: (path: string, open: boolean) => void;
}

const Row = memo(function Row({ actor, scale, selected, focusable, onSelect }: RowProps) {
  const { path, name, level, phase, depth, failures } = actor;
  const waiting = `${String(depth)} waiting`;
  return (
    <li
      role="treeitem"
      aria-level={level + 1}
      aria-selected={selected}
      aria-label={`${name}, ${PHASE_WORDS[phase]}, ${waiting}`}
      tabIndex={focusable ? 0 : -1}
      data-path={path}
      data-phase={phase}
      className={`bs-row bs-${phase}${selected ? ' bs-selected' : ''}`}
      style={{ paddingLeft: GUTTER + 8 + level * 16 }}
      onClick={() => {
        onSelect(path, true);
      }}
    >
      <span className="bs-dot" aria-hidden="true" />
      <span className="bs-name">{name}</span>
      {actor.persistenceId !== undefined && (
        <span className="bs-tag" title="Persistent: it keeps its events in a journal">
          journal
        </span>
      )}
      {phase !== 'running' && <span className="bs-phase">{PHASE_WORDS[phase]}</span>}
      {failures.length > 0 && (
        <span className="bs-failures" title={`${String(failures.length)} failures`}>
          ×{failures.length}
        </span>
      )}
      <span className="bs-mailbox" aria-hidden="true" title={waiting}>
        <span className="bs-bar">
          <span
            className="bs-fill"
            style={{ width: `${String(Math.min(100, (depth / scale) * 100))}%` }}
          />
        </span>
        <span className="bs-depth">{depth}</span>
      </span>
    </li>
  );
});
