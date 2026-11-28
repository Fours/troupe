// A rehearsed run's log, in plain words (milestone 5, T8): the faults as they begin and heal, nodes
// stopping and starting, what the others noticed, shows coming back elsewhere, and the moment an
// invariant broke. Told from the history alone, as festival night's log is told from its events,
// and once for the whole cluster: news every node sees is told by the first node to see it.
import type { Fault, History } from '@kylewillett/troupe/rehearsal';
import type { Mark } from './drawing.ts';
import { faultKind, faultText, list, showOf, word } from './drawing.ts';

/** One line of the log, at `time` in ms of simulation time. */
export interface LogLine {
  readonly time: number;
  readonly text: string;
  /** What kind of news it is, for the page to colour. */
  readonly tone: 'fault' | 'heal' | 'node' | 'show' | 'broke' | 'end';
}

/** A line whose text is told once all its news is in. */
type Draft = { -readonly [K in keyof LogLine]: LogLine[K] };

/** `s` with a capital first letter, unless it starts with a node's name, which stays as it is. */
function capitalIn(names: ReadonlySet<string>): (s: string) => string {
  return (s) => {
    const word = s.split(/[\s,’]/)[0] ?? '';
    return names.has(word) ? s : `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;
  };
}

/** What a fault's end means, or `undefined` for one that's over at once. */
function healed(fault: Fault): string | undefined {
  switch (faultKind(fault)) {
    case 'pause':
      return `${'pause' in fault ? fault.pause : ''} wakes up, as if no time had passed.`;
    case 'partition':
      return 'The partition heals.';
    case 'delay':
    case 'reorder':
    case 'lose':
    case 'duplicate':
      return 'The network is back to normal.';
    case 'slow':
    case 'hang':
    case 'error':
    case 'lostReplies':
      return 'The database is back to normal.';
    case 'cut':
      return `${'cut' in fault ? fault.cut : ''} can reach the database again.`;
    case 'drift':
      return `${'drift' in fault ? fault.drift : ''}’s clock keeps time again.`;
    default:
      return undefined;
  }
}

/** The log of a run, in time order, with the mark's line if it broke an invariant. */
export function narrate(history: History, mark: Mark | undefined): LogLine[] {
  const lines: LogLine[] = [];
  const say = (time: number, text: string, tone: LogLine['tone']): void => {
    lines.push({ time, text, tone });
  };
  const first = history[0];
  const run = first?.kind === 'run' ? first : undefined;
  const end = run === undefined ? 0 : (run.untilMs ?? run.durationMs);
  const clients = new Set(run?.clients ?? []);
  const capital = capitalIn(
    new Set(run === undefined ? [] : [...run.nodes, ...run.spares, ...run.clients]),
  );
  // News one node has about several others at once, told as one line: who went quiet, or which
  // shards' leases ran out, keyed by the moment, the node and what kind of news it is.
  const grouped = new Map<
    string,
    { readonly line: Draft; readonly names: string[]; readonly tell: (names: string[]) => string }
  >();
  const group = (
    time: number,
    node: string,
    kind: string,
    name: string,
    tone: LogLine['tone'],
    tell: (names: string[]) => string,
  ): void => {
    const key = `${String(time)} ${node} ${kind}`;
    const found = grouped.get(key);
    if (found !== undefined) {
      found.names.push(name);
      return;
    }
    const line: Draft = { time, text: '', tone };
    lines.push(line);
    grouped.set(key, { line, names: [name], tell });
  };
  const initial: string[] = [];
  const leaving = new Set<string>();
  // Incarnations that started after the cluster first formed, whose coming up is news.
  const later = new Set<string>();
  const quiet = new Set<string>();
  const down = new Set<string>();
  const back = new Set<string>();
  // Where each show last started, as its node and incarnation, and where each instance had run
  // before it started, for telling a show that moved once it has read its journal.
  const lastRan = new Map<string, string>();
  const cameFrom = new Map<string, string | undefined>();
  let invoked = 0;
  let answered = 0;

  for (const e of history) {
    switch (e.kind) {
      case 'start':
        if (e.time === 0) {
          initial.push(e.node);
        } else {
          later.add(e.node);
          say(
            e.time,
            e.inc === 0
              ? `${e.node} starts for the first time.`
              : `${e.node} starts again, as a new incarnation with an empty memory.`,
            'node',
          );
        }
        break;
      case 'stop':
        if (e.why === 'exited') {
          say(
            e.time,
            leaving.has(e.node)
              ? `${e.node} has handed off its shows, and stops.`
              : `${e.node} learns the others voted it out, and stops.`,
            'node',
          );
          leaving.delete(e.node);
        }
        break;
      case 'fault':
        if (e.phase === 'begin') {
          if ('leave' in e.fault) leaving.add(e.fault.leave);
          say(e.time, `${capital(faultText(e.fault))}.`, 'fault');
        } else {
          const text = e.fault.at === e.time ? undefined : healed(e.fault);
          if (text !== undefined) say(e.time, capital(text), 'heal');
        }
        break;
      case 'invoke':
        invoked++;
        break;
      case 'complete':
        if (e.outcome === 'ok') answered++;
        break;
      case 'event': {
        const ev = e.event;
        const subject = `${word(ev.address)}#${word(ev.uid)}`;
        switch (ev.type) {
          case 'reachability':
            if (ev.reachable === false && !quiet.has(subject)) {
              quiet.add(subject);
              group(
                e.time,
                e.node,
                'quiet',
                word(ev.address),
                'node',
                (names) =>
                  `${e.node} notices ${list(names)} ${names.length === 1 ? 'has' : 'have'} gone quiet.`,
              );
            } else if (ev.reachable === true) {
              quiet.delete(subject);
            }
            break;
          case 'memberDown':
            if (!down.has(subject)) {
              down.add(subject);
              say(e.time, `The others decide ${word(ev.address)} is down.`, 'node');
            }
            break;
          case 'memberUp':
            if (later.has(word(ev.address)) && !back.has(subject)) {
              back.add(subject);
              say(e.time, `${word(ev.address)} is up, and part of the cluster.`, 'node');
            }
            break;
          case 'spawned': {
            const show = showOf(ev.path);
            if (show === undefined) break;
            const here = `${e.node} ${String(e.inc)}`;
            cameFrom.set(`${here} ${show}`, lastRan.get(show));
            lastRan.set(show, here);
            break;
          }
          case 'recovered': {
            const show = showOf(ev.path);
            if (show === undefined) break;
            const here = `${e.node} ${String(e.inc)}`;
            const before = cameFrom.get(`${here} ${show}`);
            const events = typeof ev.lastSeq === 'number' ? ev.lastSeq : 0;
            if (before !== undefined && before !== here && events > 0) {
              say(
                e.time,
                `${show} moves to ${e.node}, and replays ${String(events)} ${events === 1 ? 'event' : 'events'} from its journal.`,
                'show',
              );
            }
            break;
          }
          case 'shardReleased':
            if (ev.reason === 'leaseLost') {
              group(e.time, e.node, 'lease', word(ev.shard), 'show', (shards) =>
                shards.length === 1
                  ? `${e.node}’s lease on shard ${shards.join('')} ran out, so it stops the shows there.`
                  : `${e.node}’s leases on shards ${list(shards)} ran out, so it stops the shows there.`,
              );
            }
            break;
          case 'failed': {
            const show = showOf(ev.path);
            const error = ev.error as { error?: unknown } | undefined;
            if (show === undefined) break;
            if (error?.error === 'JournalConflictError') {
              say(
                e.time,
                `An old copy of ${show} on ${e.node} tries to write, and the journal refuses: another copy got there first.`,
                'show',
              );
            } else {
              say(e.time, `${show} on ${e.node} fails, and starts over.`, 'show');
            }
            break;
          }
          default:
            break;
        }
        break;
      }
      default:
        break;
    }
  }

  if (initial.length > 0) {
    lines.unshift({
      time: 0,
      text: `${capital(list(initial.filter((n) => !clients.has(n))))} start, and form a cluster with the crowd’s node, which starts buying tickets.`,
      tone: 'node',
    });
  }
  if (mark !== undefined) {
    lines.push({ time: mark.time, text: `It broke: ${mark.sentence}`, tone: 'broke' });
  }
  for (const { line, names, tell } of grouped.values()) {
    line.text = tell(names);
  }
  const stopped = run?.untilMs !== undefined && mark !== undefined;
  lines.push({
    time: end,
    text: `${stopped ? 'The run stops here, once it has broken.' : 'The run ends.'} ${String(answered)} of the crowd’s ${String(invoked)} requests were answered.`,
    tone: 'end',
  });
  // Stable, so lines at one moment keep the order they happened in.
  return lines.sort((a, b) => a.time - b.time);
}
