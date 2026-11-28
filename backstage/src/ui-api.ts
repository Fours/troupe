// The /backstage/ui entry point's API, declared on its own (decision 0045). It names no React
// type, so a page that embeds Backstage needs no React of its own, and the build turns this file
// into the entry point's index.d.ts as it is. mount.tsx implements it, typed against it, so the two
// can't drift.

import type { BackstageClient } from '@kylewillett/troupe/backstage';

/**
 * Backstage's panels, in the order a narrow screen's tabs show them. `cluster` only appears for
 * a system that's a cluster node.
 */
export type Panel = 'cluster' | 'tree' | 'details' | 'timeline';

/** What {@link mountBackstage} draws, and what it tells the page. */
export interface BackstageUiOptions {
  /**
   * The system to show. Pass a new one to {@link MountedBackstage.update} when the page replaces
   * the system, and Backstage starts over from its `hello`.
   */
  readonly client: BackstageClient;
  /**
   * The selected actor's path, or `undefined` for none. The page owns the selection: Backstage
   * shows what this says, and never changes it itself.
   */
  readonly selected?: string | undefined;
  /**
   * Called with an actor's path when someone picks it in the tree. The selection changes only
   * when the page passes that path back as `selected`.
   */
  readonly onSelect: (path: string) => void;
  /**
   * Words of the page's own after each panel's explanation, such as what its actors are. Plain
   * text.
   */
  readonly explain?: Readonly<Partial<Record<Panel, string>>> | undefined;
}

/** Backstage, mounted in a page's element. */
export interface MountedBackstage {
  /**
   * Changes some of the options. The ones left out keep their values. A new `client` drops what
   * Backstage knew about the old one.
   * @throws TypeError if an option is invalid, as {@link mountBackstage} does.
   * @throws Error once unmounted.
   */
  update(changes: Partial<BackstageUiOptions>): void;
  /**
   * Ends the connection to the client and removes Backstage and its styles from the page. The
   * element can take Backstage again at once. Unmounting twice does nothing.
   */
  unmount(): void;
}

/**
 * Draws Backstage's inspector inside `element`, on `options.client`: the actor tree, the selected
 * actor's details, and a persistent actor's timeline, laid out by the room the element has. It
 * adds a child to `element` and leaves the rest of it alone, and puts its styles, scoped to its own
 * classes, in the element's document or shadow root. React is inside this entry point, so the page
 * needs none, whatever it's built with.
 * @throws TypeError if `element` isn't an element, or an option is invalid.
 * @throws Error if Backstage is already mounted in `element`.
 */
export declare function mountBackstage(
  element: Element,
  options: BackstageUiOptions,
): MountedBackstage;
