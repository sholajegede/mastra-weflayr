# Contributing

## Set up

```sh
npm install
```

Node 22.13 or later (Mastra's own requirement).

## Before you open a pull request

```sh
npm run build
npm run lint
npm run typecheck
npm test
```

CI runs these on Node 22 and 24. It also runs the tests against `@mastra/core`
1.34.0, 1.50.0 and the latest release, so a change that only works on one Mastra
version is caught.

The tests never call the network. `tests/gateway.ts` replaces `fetch` with a
fake Weflayr gateway and runs real Mastra agents against it.

## Where things are

| Path                | What it holds                                           |
| ------------------- | ------------------------------------------------------- |
| `src/index.ts`      | The whole package: `Weflayr`, the processors, the types |
| `tests`             | Tests, and the fake gateway they use                    |
| `examples/live.ts`  | A real run through the gateway (needs a Weflayr key)    |
| `docs`              | Architecture and operations notes                       |

## Rules

- Every new behaviour has a test.
- Update `README.md` and `CHANGELOG.md` when the public API changes.
- The package never stores or logs prompts, answers or API keys.
- Recording a step must never fail a run. Errors there are logged and swallowed.

## Releases

Maintainers release by tag. See [PUBLISHING.md](./PUBLISHING.md).
