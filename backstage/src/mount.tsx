// The /backstage/ui entry point (decision 0045): Backstage mounted in an element a page gives it,
// with React built in, so the page needs none and the package still has no dependencies. Its API
// is declared in ui-api.ts, which names no React type. The page owns the selection, as the
// demo's pages do, and a new client starts the view over, as a restarted system does.

import { createRoot } from 'react-dom/client';
import type * as Api from './ui-api.ts';
import type { BackstageUiOptions, MountedBackstage, Panel } from './ui-api.ts';
import { Backstage } from './ui/Backstage.tsx';
import styles from './ui/backstage.css?inline';

export type { BackstageUiOptions, MountedBackstage, Panel } from './ui-api.ts';

const PANELS: ReadonlySet<string> = new Set<Panel>(['cluster', 'tree', 'details', 'timeline']);
const OPTIONS: ReadonlySet<string> = new Set(['client', 'selected', 'onSelect', 'explain']);

/** Elements that have Backstage in them now. */
const mounted = new WeakSet<Element>();

/** One style element per document or shadow root, for as many Backstages as are mounted there. */
const sheets = new Map<Node, { readonly style: HTMLStyleElement; count: number }>();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// By nodeType rather than instanceof, so an element from another frame counts too.
const isElement = (value: unknown): value is Element =>
  isObject(value) && value.nodeType === 1 && typeof value.append === 'function';

/** `options`, checked whole, so a mistake throws where it's made and not on a later draw. */
function checked(options: unknown, where: string): BackstageUiOptions {
  if (!isObject(options)) throw new TypeError(`${where}: options must be an object`);
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) throw new TypeError(`${where}: unknown option ${key}`);
  }
  const { client, selected, onSelect, explain } = options;
  if (!isObject(client) || typeof client.connect !== 'function') {
    throw new TypeError(`${where}: client must be a BackstageClient, with connect and request`);
  }
  if (typeof client.request !== 'function') {
    throw new TypeError(`${where}: client must be a BackstageClient, with connect and request`);
  }
  if (selected !== undefined && typeof selected !== 'string') {
    throw new TypeError(`${where}: selected must be an actor's path or undefined`);
  }
  if (typeof onSelect !== 'function') throw new TypeError(`${where}: onSelect must be a function`);
  if (explain !== undefined) {
    if (!isObject(explain)) throw new TypeError(`${where}: explain must be an object`);
    for (const [panel, words] of Object.entries(explain)) {
      if (!PANELS.has(panel)) throw new TypeError(`${where}: explain has no panel ${panel}`);
      if (typeof words !== 'string') throw new TypeError(`${where}: explain.${panel} must be text`);
    }
  }
  // A copy, so a page that changes its object afterwards changes nothing until it calls update.
  return {
    client: client as unknown as BackstageUiOptions['client'],
    selected,
    onSelect: onSelect as BackstageUiOptions['onSelect'],
    explain: explain === undefined ? undefined : { ...(explain as BackstageUiOptions['explain']) },
  };
}

/**
 * Whether two sets of options draw the same. A page may pass its options on every render of its
 * own, with `explain` a new object each time, and drawing again for nothing would cost it frames.
 */
function same(a: BackstageUiOptions, b: BackstageUiOptions): boolean {
  if (a.client !== b.client || a.selected !== b.selected || a.onSelect !== b.onSelect) return false;
  const ea = a.explain ?? {};
  const eb = b.explain ?? {};
  return [...PANELS].every((panel) => ea[panel as Panel] === eb[panel as Panel]);
}

/** Where `element`'s styles go: its shadow root if it's in one, else its document. */
function styleRoot(element: Element): { readonly key: Node; readonly parent: ParentNode } {
  const root = element.getRootNode();
  if (root.nodeType === 11 && root !== element.ownerDocument) {
    return { key: root, parent: root as ShadowRoot };
  }
  const doc = element.ownerDocument;
  return { key: doc, parent: doc.head };
}

/** Puts the styles in `element`'s root once, and returns what takes them away again. */
function addStyles(element: Element): () => void {
  const { key, parent } = styleRoot(element);
  let sheet = sheets.get(key);
  if (sheet === undefined) {
    const style = element.ownerDocument.createElement('style');
    style.dataset.troupeBackstage = '';
    style.textContent = styles;
    parent.append(style);
    sheet = { style, count: 0 };
    sheets.set(key, sheet);
  }
  sheet.count += 1;
  const own = sheet;
  return () => {
    own.count -= 1;
    if (own.count > 0) return;
    own.style.remove();
    sheets.delete(key);
  };
}

/** {@inheritDoc Api.mountBackstage} */
export const mountBackstage: typeof Api.mountBackstage = (element, options) => {
  if (!isElement(element)) throw new TypeError('mountBackstage: element must be an element');
  let current = checked(options, 'mountBackstage');
  if (mounted.has(element)) {
    throw new Error('mountBackstage: Backstage is already mounted in this element');
  }

  // A child of its own, so the page's other children stay, and a new mount right after an
  // unmount doesn't share a container with a root React is still tearing down.
  const host = element.ownerDocument.createElement('div');
  element.append(host);
  mounted.add(element);
  const removeStyles = addStyles(element);
  const root = createRoot(host);
  const draw = (): void => {
    const { client, selected, onSelect, explain } = current;
    root.render(
      <Backstage client={client} selected={selected} onSelect={onSelect} explain={explain ?? {}} />,
    );
  };
  draw();

  let live = true;
  const handle: MountedBackstage = {
    update(changes) {
      if (!live) throw new Error('MountedBackstage.update: Backstage was unmounted');
      if (!isObject(changes)) {
        throw new TypeError('MountedBackstage.update: changes must be an object');
      }
      const next = checked({ ...current, ...changes }, 'MountedBackstage.update');
      if (same(current, next)) return;
      current = next;
      draw();
    },
    unmount() {
      if (!live) return;
      live = false;
      root.unmount();
      host.remove();
      removeStyles();
      mounted.delete(element);
    },
  };
  return handle;
};
