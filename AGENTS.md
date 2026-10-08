# Repository Guidelines

## Project Structure & Module Organization

This is a Bun/TypeScript monorepo for PRiSM Next. Core business rules live in `packages/core`, use-case services in `packages/application`, SQL schema and repositories in `packages/storage-sql`, and database adapters in `packages/adapter-sqlite` and `packages/adapter-d1`. The unified API, multi-tenant routes, hardware drivers, and Worker & Bun entrypoints are in `packages/server`.

The Koishi plugin lives in the `packages/koishi-plugin` git submodule (standalone repo `koishi-plugin-prism`). The React admin and player client lives in `packages/prism-web`. D1 migrations live in `migrations`, and references belong in `docs`. Most packages keep source in `src/` and tests in `test/`.

## Build, Test, and Development Commands

- `bun install`: install workspace dependencies from `bun.lock`.
- `bun test`: run all Bun tests across the repository.
- `bun run typecheck`: run TypeScript project-reference checks.
- `bun run dev:local`: start the local Bun + SQLite runtime.
- `bun run dev:worker`: run the Cloudflare Worker through Wrangler.
- `bun run deploy:worker`: deploy the Worker.
- `bun run db:migrate:local` / `bun run db:migrate:remote`: apply D1 migrations locally or remotely.
- `bun run dev:all`: start the local platform Worker, React Vite server and optional AstrBot.
- `bun run build:web`: build the React admin and player UI.
- `bun run check:platform`: build React and check the Worker bundle without deploying.
- `bun run deploy:beta`: build React, apply D1 migrations and deploy the unified platform.

## Coding Style & Naming Conventions

Use ES modules, strict TypeScript, and package exports that point at `src/index.ts`. Keep domain logic pure in `core`; place orchestration in `application`; keep runtime-specific code in adapters or runtime packages. Use kebab-case file names such as `staff-pricing.ts`, PascalCase React components, and descriptive test names. Prefer two-space indentation and concise, typed functions.

## Testing Guidelines

Use Bun’s test runner for TypeScript packages. Put tests under `packages/<name>/test` and name them `*.test.ts`. Add focused tests near changed behavior, and broaden coverage when touching shared contracts, storage, migrations, billing, or session rules. Run `bun test` and `bun run typecheck` before submitting. For UI or deployment changes, also run `bun run check:platform`.

## Commit & Pull Request Guidelines

Recent history uses short, direct subjects such as `split admin ui into view components`, `optimize ui`, and occasional Chinese summaries. Keep commits concise and scope-focused. Pull requests should describe the user-facing change, list verification commands, link related issues or docs, and include screenshots for UI changes.

## Security & Configuration Tips

Do not commit real store data, API tokens, generated credentials, or local SQLite databases. Use `PRISM_SQLITE_PATH` only for local persistence needs, and keep Worker/D1 identifiers in Wrangler configuration appropriate for the target environment.

## Documentation Synchronization

Every time you modify the code, you must update the corresponding documentation to keep it consistent with the code implementation (每次修改完代码后，必须相应修改文档内容，确保文档与代码实现保持一致)。
