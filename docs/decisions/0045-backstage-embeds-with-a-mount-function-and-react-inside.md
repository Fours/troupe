# 0045. A page embeds Backstage with `mountBackstage`, from an entry point that has React inside it

- **Status:** Accepted
- **Date:** 2026-11-28
- **Milestone:** 5

## Context

Backstage's UI is React and plain CSS in `backstage/src/`. Until now it shipped only as the built page `serveBackstage` serves, and the demo imported it straight from `backstage/src/`, so it wasn't part of the package's API. Steadfast, a runtime for durable AI agents built on Troupe, puts its run view beside Backstage on its demo page, with the selection linked both ways, and it depends on Troupe's public entry points only. So it can't use the UI at all (Steadfast's milestone 3, task T1 and open question 1).

Two rules constrain how. The package has no runtime dependencies and no peer dependencies, which every milestone's definition of done says, and which 0017, 0023 and 0027 kept by turning down a peer each time. And a user who doesn't embed the UI mustn't pay for it: neither the main entry nor `/backstage` may load it.

## Decision

- **A new entry point, `@kylewillett/troupe/backstage/ui`, exports one function.** `mountBackstage(element, { client, selected, onSelect, explain })` draws Backstage in a new child of `element`, on `client`, any `BackstageClient`, and returns `{ update(changes), unmount() }`.
- **`BackstageClient` is public, as a type in `/backstage`:** `connect(listener)` and `request(req)`, which the in-process source already had. `BackstageSource` extends it, and the UI's HTTP client fits it too.
- **The page owns the selection.** Picking an actor in the tree calls `onSelect(path)`, and the selection changes only when the page passes the path back as `selected`. That's how the demo's pages always used the component, and it's what lets Steadfast's run view and Backstage select each other.
- **The tree's keys move from the focused row, not the selection.** The selection comes back from the page when it passes it on, which can be a render later than the key that asked for it. So a second arrow key would start from where the first began.
- **`explain` is plain text**, the words of the page's own after each panel's explanation. The demo's were text already.
- **A new system is a new client.** `update({ client })` drops what the UI knew and starts over from the new client's `hello`. A client that follows restarts itself, as the demo's do, works too, since a second `hello` already meant a new system.
- **React and React DOM are inside the entry point.** Vite builds `backstage/src/mount.tsx` into one ES module, for production and minified, with the styles in it as text. `mountBackstage` adds them to the element's document, or its shadow root if it's in one, once however many are mounted there, and the last `unmount` removes them. The file imports nothing.
- **The API is declared on its own.** `backstage/src/ui-api.ts` holds the entry point's types and a `declare function`, and names only DOM types and `/backstage`'s `BackstageClient`, never a React type, so a user needs no `@types/react`. The build turns it into `dist/backstage/ui/index.d.ts` with TypeScript's `transpileDeclaration`, which fails on anything but plain declarations. `mount.tsx` is typed as `typeof` that declaration, so the two can't drift.
- **`update` draws again only when something changed**, `explain`'s words included. So a page can pass its options on every render of its own, as the demo's wrapper does, without costing Backstage a render each time. The frame-budget tests in `e2e/frames.spec.ts` still pass with Backstage in a root of its own.
- **Invalid options throw a `TypeError` when they're passed in**, to `mountBackstage` and to `update`, and a failed update changes nothing. Mounting twice in one element throws, and an update after `unmount` throws.
- **The demo uses it by name.** Both live pages mount Backstage through `@kylewillett/troupe/backstage/ui` in a small wrapper, `demo/src/Backstage.tsx`, as any React page would. The demo points the package's name at this checkout's source, so its bundler shares the demo's own React with Backstage. The one import left from `backstage/src/` is `colourOf`, which festival night's cards share with Backstage's Cluster panel so their colours agree. That's how this repo's two pages match, not something an embedding page needs, so it isn't exported.

## Alternatives considered

| Option | Why not |
| --- | --- |
| React components, `<Backstage>`, with `react` and `react-dom` as optional peer dependencies | Breaks "no peer dependencies", and gives users a React range for Troupe to test and keep. Each bundler would need a way to load the CSS. It would save a React page a second copy of React, the one real cost of this decision, which is why it stays open below |
| React components, with React used but not declared | A dependency in hiding. A strict package manager refuses it, and a version mismatch fails at run time, not at install |
| A custom element, `<troupe-backstage>` | Registering a tag name is a global side effect: two copies of the package on one page clash. A client and a callback are properties, not attributes, so a page sets the same options either way. It can be built on `mountBackstage` later if anyone wants one |
| Panels from other packages inside Backstage (Steadfast's option (b)) | An extension API to design, test and keep, for one user. Steadfast chose to sit beside Backstage instead, which needs only this |
| Mounting in a shadow root of its own, to isolate the styles | Not needed: every class is `bs-` and every token `--bs-`, scoped under `.backstage`, and nothing styles the page. A page that wants isolation mounts it in its own shadow root, and the styles go there |
| The demo keeps importing `backstage/src/` | Then nothing in the repo uses the entry point as a user would, and the demo would need things the API doesn't have without anyone noticing |

## Evidence

- **It loads nothing else, and nothing else loads it.** `test/package.test.ts` imports `/backstage/ui` from the built package in a fresh Node process and sees exactly one module, `dist/backstage/ui/index.js`: no React from `node_modules`, nothing more from `dist/`. Every other entry point, the main one and `/backstage` included, loads neither it nor React. Its declarations import only `../index.js`, `/backstage`'s. The export-list tests check its one value and three types.
- **No dependency hides in it.** `scripts/check-pack.ts` reads the packed UI file's imports with TypeScript's scanner and fails on any, alongside its check that `package.json` declares no dependencies of any kind. With `react` and `react-dom` marked external in the build, both it and the package test fail.
- **The file that ships works on a page with no React.** `e2e/embed.spec.ts` serves a plain HTML page and `dist/` to Chromium, and nothing else. The page's module script creates actor systems with `dist/index.js` and mounts the built UI on them. Backstage shows the system's actors beside what the element already held, with the page's words under its panel. A click calls `onSelect` and selects nothing until `update({ selected })`. A new client shows the new system and not the old one. `unmount` takes Backstage and its styles away, and it mounts again in the same element. In a shadow root its styles go in the shadow root. Each kind of invalid option throws.
- **The demo needs nothing more.** Opening night and festival night mount Backstage through the entry point, and their Playwright tests, written against the component before, pass unchanged. One of them found the keyboard's problem: in `e2e/backstage.spec.ts`, two quick presses of ↑ left focus a row short, because the selection hadn't come back from the page yet. It passes now that the keys move from the focused row.
- **The size.** The entry point is 265 KB, 82 KB gzipped: React and React DOM, about 60 KB of that gzipped, and Backstage's own code and styles. A user who doesn't import it downloads it with the package and never loads it.

## Consequences

- Any page can show Backstage, whatever it's built with, and the package still has no dependencies. React's version is Troupe's choice, invisible to users, and a React fix reaches them only in a Troupe release.
- A page that is itself React loads a second copy of React, about 60 KB gzipped. Steadfast's demo will. If that matters to someone, a second entry point of React components with React as an optional peer can come later, but it needs "no peer dependencies" changed in a record of its own.
- The components behind it stay private, so they can change freely: the API is the one function, its options and its handle. Adding an option is a minor change, and `explain` taking more than text would be a new option, not a wider type.
- The two live demo pages inject Backstage's styles when it mounts instead of loading them as a stylesheet, since they mount it as every page does.
