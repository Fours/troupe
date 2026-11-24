// Festival night's log in plain words. The processes write JSON lines (log.ts), which the
// multi-process test and the smoke script read. This turns them into what a person watching wants
// to know: which node hosts which show, when a node goes quiet, and when its shows answer again,
// from where, with every sale they had acknowledged. Pure: lines and their times in, sentences out.
// narrate.ts feeds it `docker compose logs`, and scripts/cluster-smoke.ts checks its state.

/** What the story knows about one show, from the crowd's answers. */
export interface ShowState {
  /** The node whose incarnation answered last, such as `node-1`. */
  node: string;
  /** The incarnation that answered last, `<address>#<uid>:<n>`. */
  inc: string;
  /** The number of the last acknowledged sale. */
  lastSale: number;
  /** When the last sale was acknowledged, in ms. */
  lastAckAt: number;
  /** Whether asks have been timing out since the last sale. */
  silent: boolean;
}

/** A show that answered from another node, after an outage or a handoff. */
export interface Move {
  readonly show: string;
  readonly from: string;
  readonly to: string;
  /** From its last acknowledged sale on `from` to its first on `to`, in ms. */
  readonly gapMs: number;
  /** Whether asks timed out in between: a failover rather than a handoff. */
  readonly failover: boolean;
  readonly at: number;
}

/** How often the story sums up the sales and who hosts what, in ms. */
export const SUMMARY_EVERY_MS = 10_000;

/** `node-2:2552` or `node-2:2552#123:4` to `node-2`. */
export function nodeName(addressOrInc: string): string {
  const host = addressOrInc.split('#')[0] ?? addressOrInc;
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** The number at the end of a sale id, `hamlet-412` to 412. */
function saleNumber(saleId: string): number {
  return Number(saleId.slice(saleId.lastIndexOf('-') + 1));
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

type Line = Record<string, unknown> & { ev?: unknown };

/** The story so far. Feed it every line, in order, with the time it was written. */
export class Story {
  /** Every show the crowd has had an answer from, by id. */
  readonly shows = new Map<string, ShowState>();
  /** Every show that has answered from a new node, in order. */
  readonly moves: Move[] = [];
  /** Anything that should never happen, such as an acknowledged sale that went missing. */
  readonly problems: string[] = [];

  private start: number | undefined;
  private nextSummary = 0;
  private salesSinceSummary = 0;
  /** Who hosted what at the last summary, so an unchanged placement isn't said again. */
  private lastPlacement = '';
  private readonly backstage = new Map<string, string>();
  private readonly unreachable = new Set<string>();
  private readonly down = new Set<string>();
  private readonly incarnations = new Map<string, number>();

  /**
   * One line a process wrote, and the sentences it adds to the story, each starting with the
   * seconds since the first line. Lines that aren't JSON, such as Postgres's, add nothing.
   * @param service The process, such as `node-1` or `crowd`.
   * @param at When it was written, in ms on any clock, as long as it's the same one throughout.
   */
  read(service: string, text: string, at: number): string[] {
    let line: Line;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
      line = parsed as Line;
    } catch {
      return [];
    }
    if (this.start === undefined) {
      this.start = at;
      this.nextSummary = at + SUMMARY_EVERY_MS;
    }
    const out: string[] = [];
    if (at >= this.nextSummary) {
      // Stamped with the moment it sums up to, not the line that came after it.
      const stamp = this.clock(this.nextSummary);
      out.push(...this.summary().map((sentence) => `${stamp}  ${sentence}`));
      while (this.nextSummary <= at) this.nextSummary += SUMMARY_EVERY_MS;
    }
    const stamp = this.clock(at);
    out.push(...this.sentences(service, line, at).map((sentence) => `${stamp}  ${sentence}`));
    return out;
  }

  private clock(at: number): string {
    return `${((at - (this.start ?? at)) / 1000).toFixed(1)}s`.padStart(7);
  }

  private summary(): string[] {
    const sold = this.salesSinceSummary;
    this.salesSinceSummary = 0;
    if (sold === 0 || this.shows.size === 0) return [];
    const byNode = new Map<string, string[]>();
    for (const [show, state] of this.shows) {
      if (state.silent) continue;
      byNode.set(state.node, [...(byNode.get(state.node) ?? []), show]);
    }
    const hosts = [...byNode.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, shows]) => `${node} has ${shows.join(', ')}`);
    const silent = [...this.shows.entries()].filter(([, s]) => s.silent).map(([show]) => show);
    const placement = [
      ...hosts.map((h) => `  ${h}.`),
      ...(silent.length > 0 ? [`  Not answering: ${silent.join(', ')}.`] : []),
    ];
    const changed = placement.join('\n') !== this.lastPlacement;
    this.lastPlacement = placement.join('\n');
    return [
      `${plural(sold, 'sale')} in the last ${seconds(SUMMARY_EVERY_MS)}.`,
      ...(changed ? placement : []),
    ];
  }

  private sentences(service: string, line: Line, at: number): string[] {
    switch (line.ev) {
      case 'backstage':
        this.backstage.set(service, String(line['url']));
        return [];
      case 'up': {
        const url = this.backstage.get(service);
        const where = url === undefined ? '' : ` Backstage: ${url}`;
        return [
          line['host'] === false
            ? `The crowd is in the cluster, and starts buying seats.${where}`
            : `${service} is up, and can host shows.${where}`,
        ];
      }
      case 'ack':
        return this.ack(line, at);
      case 'timeout':
        return this.timeout(String(line['show']));
      case 'refused':
        return [`${String(line['show'])} refused a sale: ${String(line['reason'])}.`];
      case 'error':
        return [`An ask to ${String(line['show'])} failed: ${String(line['message'])}.`];
      case 'reachability':
        return this.reachability(line);
      case 'memberUp':
        return this.memberUp(line);
      case 'memberDown': {
        const node = nodeName(String(line['address']));
        if (this.down.has(node)) return [];
        this.down.add(node);
        return [`${node} has been silent too long, and is marked down.`];
      }
      case 'leaving':
        return [`${service} is leaving gracefully, handing its shows off first.`];
      case 'left':
        return [`${service} has handed off its shows, and stopped.`];
      case 'downed':
        return [`${service} learned it was marked down, and restarts as a new node.`];
      case 'failed':
        return [`${String(line['path'])} failed on ${service}.`];
      case 'log':
        return line['level'] === 'error'
          ? [`${service} logged an error: ${String(line['msg'])}`]
          : [];
      default:
        return [];
    }
  }

  private ack(line: Line, at: number): string[] {
    const show = String(line['show']);
    const inc = String(line['inc']);
    const sale = saleNumber(String(line['saleId']));
    const node = nodeName(inc);
    this.salesSinceSummary++;
    const before = this.shows.get(show);
    this.shows.set(show, { node, inc, lastSale: sale, lastAckAt: at, silent: false });
    if (before === undefined) return [];
    const out: string[] = [];
    // A sale's number is one more than the sales the show had recovered. Any acknowledged sale
    // missing from the journal would make it reuse a number.
    if (sale <= before.lastSale) {
      const problem = `${show} answered from ${node} with sale ${String(sale)}, but sale ${String(before.lastSale)} had been acknowledged: sales were lost.`;
      this.problems.push(problem);
      out.push(problem);
    }
    if (node === before.node && !before.silent) return out;
    const gapMs = at - before.lastAckAt;
    if (node !== before.node) {
      this.moves.push({ show, from: before.node, to: node, gapMs, failover: before.silent, at });
    }
    // Its new incarnation numbers sales after the ones it recovered from the journal.
    const recovered = `It picked up at sale ${String(sale)}, so its ${plural(before.lastSale, 'confirmed sale')} survived.`;
    if (!before.silent) {
      out.push(`${show} moved from ${before.node} to ${node} in ${seconds(gapMs)}. ${recovered}`);
    } else if (node === before.node) {
      out.push(`${show} answers again, from ${node}, ${seconds(gapMs)} after its last sale.`);
    } else {
      out.push(
        `${show} answers again, now from ${node}, ${seconds(gapMs)} after its last sale on ${before.node}. ${recovered}`,
      );
    }
    return out;
  }

  private timeout(show: string): string[] {
    const state = this.shows.get(show);
    if (state === undefined || state.silent) return [];
    state.silent = true;
    return [`${show} didn't answer in time. The crowd keeps asking.`];
  }

  private reachability(line: Line): string[] {
    const node = nodeName(String(line['address']));
    if (line['reachable'] === false) {
      if (this.unreachable.has(node) || this.down.has(node)) return [];
      this.unreachable.add(node);
      return [`${node} stopped answering heartbeats. Its shows can't be reached.`];
    }
    if (!this.unreachable.delete(node)) return [];
    return [`${node} is answering heartbeats again.`];
  }

  private memberUp(line: Line): string[] {
    const node = nodeName(String(line['address']));
    const uid = Number(line['uid']);
    const known = this.incarnations.get(node);
    this.incarnations.set(node, uid);
    if (known === undefined || known === uid) return [];
    this.down.delete(node);
    this.unreachable.delete(node);
    return [`${node} is back, as a new incarnation. Shows will move to it, a few at a time.`];
  }
}
