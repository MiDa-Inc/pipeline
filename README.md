# Pipeline

Pipeline is a local, open-source tool for running AI coding agents in a defined workflow. It is
being built one step at a time from [`PLAN.md`](PLAN.md).

**Status: scaffold only.** Build tooling, CI, six empty packages with placeholder tests, and one
example project. None of the product behavior (engine, runtimes, profiles, CLI, server, UI)
exists yet.

Requires Node.js 20.19+ and pnpm 9 (`corepack enable` picks up the version pinned in
`package.json`).

- `pnpm install` — install every workspace package from the committed lockfile
- `pnpm lint` — ESLint over the repo, then a Prettier formatting check
- `pnpm test` — Vitest in every package
- `pnpm build` — `tsc` in every package, emitting to each `dist/`

Run one package with `pnpm --filter @pipeline/core test`. CI runs the same install, lint, test and
build checks on Node 20 and 22.

## Layout

```
packages/
  core/       schema, validation, engine, run log, verdict parser, templates
  runtime/    RuntimeAdapter interface, FakeRuntime, HerdrRuntime
  profiles/   agent profile schema and built-in profiles
  cli/        the `pipeline` command
  server/     local HTTP and WebSocket server
  ui/         React app (skeleton live view first, full editor later)
examples/
  sample-app/ tiny project with real tests, used for end-to-end runs
```

Each package under `packages/` is a placeholder: one exported constant and one test proving the
package builds and its tests run.

`examples/sample-app` is a self-contained word-counting CLI. It declares its own TypeScript and
Vitest versions and uses its own `tsconfig.json`, so its tests run on their own:

```
cd examples/sample-app && pnpm test
pnpm build && node dist/main.js "the cat the hat"
```

Agents working here follow [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md). [MIT](LICENSE).
