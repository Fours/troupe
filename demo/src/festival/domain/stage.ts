// The cluster map: which node runs which show, built from every node's events. A show is on a
// node from its entity's `spawned` there to its `stopped`. A killed node says nothing more, so its
// shows stay on it, stranded, until they start somewhere else: what the page shows while the
// others wait for its leases to run out.
import { HOSTS, type FestivalEvent, type FestivalNight, type NodeState } from './festival-night.ts';

/** An entity of type `show`: `/system/sharding/show/<shard>/<id>`. */
export const ENTITY_PATH = /^\/system\/sharding\/show\/(\d+)\/([^/]+)$/;

/** One show on one node's card. */
export interface StageShow {
  readonly id: string;
  /** Its node was killed while it ran there, and it hasn't started anywhere else yet. */
  readonly stranded: boolean;
}

/** One hosting node, as the map shows it. */
export interface StageNode {
  readonly address: string;
  readonly state: NodeState;
  readonly incarnation: number;
  /** In the lineup's order of first appearance on this node. */
  readonly shows: readonly StageShow[];
}

/** The map: every hosting address used so far, in address order. */
export interface StageView {
  readonly nodes: readonly StageNode[];
}

/** Keeps the map from festival events. */
export class Stage {
  // Shows running on each address, and those stranded there by a kill.
  readonly #running = new Map<string, Set<string>>();
  readonly #stranded = new Map<string, Set<string>>();
  readonly #night: FestivalNight;

  constructor(night: FestivalNight) {
    this.#night = night;
  }

  /** Takes one event. */
  apply(e: FestivalEvent): void {
    if (e.kind === 'press') {
      if (e.press === 'kill' && e.address !== undefined) {
        const running = this.#running.get(e.address) ?? new Set();
        const stranded = this.#stranded.get(e.address) ?? new Set();
        for (const id of running) stranded.add(id);
        this.#stranded.set(e.address, stranded);
        this.#running.delete(e.address);
      }
      return;
    }
    const { event, node } = e;
    if (event.type !== 'spawned' && event.type !== 'stopped') return;
    const id = ENTITY_PATH.exec(event.path)?.[2];
    if (id === undefined) return;
    const running = this.#running.get(node.address) ?? new Set();
    this.#running.set(node.address, running);
    if (event.type === 'spawned') {
      running.add(id);
      for (const stranded of this.#stranded.values()) stranded.delete(id);
    } else {
      running.delete(id);
    }
  }

  /** The map now. */
  view(): StageView {
    return {
      nodes: HOSTS.flatMap((address) => {
        const node = this.#night.node(address);
        if (node === undefined) return [];
        const stranded = this.#stranded.get(address) ?? new Set<string>();
        const running = this.#running.get(address) ?? new Set<string>();
        return [
          {
            address,
            state: node.state,
            incarnation: node.incarnation,
            shows: [
              ...[...running].map((id) => ({ id, stranded: false })),
              ...[...stranded].map((id) => ({ id, stranded: true })),
            ],
          },
        ];
      }),
    };
  }
}
