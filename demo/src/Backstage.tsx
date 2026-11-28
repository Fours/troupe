// Backstage on the demo's pages, through the package's /backstage/ui entry point as any page
// would use it (decision 0045): mounted once in an element of its own, then given each new
// option. The demo imports the package from this checkout's src/, so its bundler shares the
// demo's React with Backstage, where a page using the published package gets React inside it.

import type { BackstageClient } from '@kylewillett/troupe/backstage';
import {
  mountBackstage,
  type BackstageUiOptions,
  type MountedBackstage,
} from '@kylewillett/troupe/backstage/ui';
import { useEffect, useRef } from 'react';

/** What the demo's pages pass, as mountBackstage's options. */
export interface BackstageProps {
  readonly client: BackstageClient;
  readonly selected: string | undefined;
  readonly onSelect: (path: string) => void;
  readonly explain?: BackstageUiOptions['explain'];
}

/** Backstage, mounted in a div of its own. */
export function Backstage({ client, selected, onSelect, explain }: BackstageProps) {
  const element = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedBackstage | null>(null);

  // Mounted by the first run, and updated by every later one. The div is rendered below, so it's
  // there by the time an effect runs.
  useEffect(() => {
    const options = { client, selected, onSelect, explain };
    if (mounted.current !== null) {
      mounted.current.update(options);
    } else if (element.current !== null) {
      mounted.current = mountBackstage(element.current, options);
    }
  }, [client, selected, onSelect, explain]);

  // Only leaving the page unmounts it, never a change of option.
  useEffect(
    () => () => {
      mounted.current?.unmount();
      mounted.current = null;
    },
    [],
  );

  return <div ref={element} />;
}
