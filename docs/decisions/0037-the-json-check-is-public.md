# 0037. The JSON check is public: `JsonValue`, `isJsonValue` and `jsonProblem` from the main entry

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

Events and snapshot states must be JSON values, checked before they're written ([0014](0014-events-are-json.md)), and messages to entities are checked the same way ([0025](0025-messages-on-the-wire-are-json-plus-refs.md)). The type and the check lived in `src/json.ts`, used by the persistent actor and the backends, but no entry point exported them. Code built on Troupe that produces values it will later persist, such as Steadfast's tool results, needs the same check earlier, where a failure can still become an ordinary result instead of a failed write. Without it, every such library copies the walk and drifts from it: a copy that accepts a hole or a class instance would pass its own check and fail Troupe's at write time.

## Decision

`@kylewillett/troupe` exports the `JsonValue` type, `isJsonValue(value)` and `jsonProblem(value)`, the same functions the persistent actor and the backends use. `jsonProblem` names where a value stops being JSON, as a path such as `$.items[2] is a hole`, or returns `undefined`.

- They live in the main entry, not `/persistence`, because the wire uses the same definition and the check needs nothing from persistence. They run on any runtime ([0004](0004-runtime-agnostic-core.md)).
- `jsonCopy` and its hooks stay internal: they exist for the wire's ref encoding and key escaping, whose shape may change with it.
- The problem strings are for people, not for parsing. Their wording may change in a minor version.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the check internal and let users copy it | Copies drift, and a value a copy accepts can still fail Troupe's check at write time, which is exactly the late failure 0014 exists to prevent. |
| Export from `/persistence` | That's where events are checked, but messages on the wire use the same definition, and a library that only sends to entities shouldn't load the persistence entry for it. |
| Export `jsonCopy` too | Its hooks are the wire's encoding details. Exporting them would freeze that encoding into the public API. |
| A Standard Schema for JSON values | Heavier than a function, and 0018's schemas are for an event's shape, not for whether it can be stored at all. |

## Evidence

- `test/package.test.ts` checks the main entry exports exactly the listed names, `isJsonValue`, `jsonProblem` and `JsonValue` among them, in the built types and the tarball.
- `test/json.test.ts`, "the main entry": the exported functions are the ones the persistent actor uses, and `JsonValue` from the main entry is the type events are checked against.

## Consequences

- Libraries on Troupe check values with the same rules the journal enforces, so a value that passes their check is one Troupe will write.
- `JsonValue` and the two functions are public API: renaming them or changing what counts as JSON is a breaking change.
- First used by Steadfast, which checks a tool's output before it journals the result.
