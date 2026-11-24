// Festival night's lineup: a dozen shows, each an entity of type `show`, and the box office on the
// crowd's node that sends each request to its show wherever it runs. The show itself is opening
// night's, so holds, sales, returns and recovery from the journal work as they do there.
import { actor, type ActorRef } from '@kylewillett/troupe';
import type { EntityType } from '@kylewillett/troupe/cluster';
import type { Persistence } from '@kylewillett/troupe/persistence';
import { show, unknownShow, type CustomerRequest, type ShowMsg } from '../../domain/shows.ts';

/** Tonight's shows, by entity id, with their number of seats. */
export const LINEUP: Readonly<Record<string, number>> = {
  hamlet: 120,
  macbeth: 80,
  othello: 60,
  lear: 40,
  'the-tempest': 90,
  'twelfth-night': 70,
  'as-you-like-it': 50,
  'much-ado': 60,
  'the-seagull': 40,
  'uncle-vanya': 30,
  'three-sisters': 50,
  'the-cherry-orchard': 70,
};

/** The show ids, in the lineup's order. */
export const SHOW_IDS: readonly string[] = Object.keys(LINEUP);

/** Whether `id` is a show tonight. */
export const isShow = (id: string): boolean => Object.hasOwn(LINEUP, id);

/** The `entity` for `sharding.init`: the show with this id, as opening night runs it. */
export function showEntity(persistence: Persistence) {
  return (id: string) => show(id, LINEUP[id] ?? 0, persistence);
}

/**
 * The box office on the crowd's node: it sends each request to its show's entity ref, which finds
 * the show on whichever node runs it. The show answers the customer directly, across the network.
 */
export function festivalOffice(shows: EntityType<ShowMsg>) {
  return actor<CustomerRequest, null>({
    initial: null,
    receive: (state, msg) => {
      if (isShow(msg.show)) (shows.ref(msg.show) as ActorRef<CustomerRequest>).tell(msg);
      else unknownShow(msg);
      return state;
    },
  });
}
