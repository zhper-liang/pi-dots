# Repository Guidelines

Pidot is a local, single-user multi-Bot assistant. The runnable application lives in `my-app/`; product, architecture, interface, and operations guidance lives under `docs/`.

## Project Structure & Module Organization

- `my-app/src/`: React and TypeScript frontend components, views, styles, and client helpers.
- `my-app/server/`: Node.js ESM API, persistence, integrations, workflow logic, and server tests.
- `my-app/public/` and `my-app/src/assets/`: static and bundled assets.
- `docs/`: durable product, architecture, interface, and engineering documentation.
- `plans/`: active work, completed implementation records, and backlog proposals.
- `NEXT_STAGE.md`: current project state and delivery boundaries. Read it and the relevant `docs/` pages before changing behavior.

## Build, Test, and Development Commands

Run these from `my-app/`:

```sh
pnpm install --frozen-lockfile  # install the locked dependency set
pnpm dev:api                    # run the local API in development
pnpm dev                        # run the Vite frontend
pnpm test                       # run server/*.test.mjs with node --test
pnpm lint                       # run oxlint
pnpm build                      # type-check and create the Vite build
pnpm start:api                  # serve the built app and API locally
```

The service binds to `127.0.0.1`. Keep credentials in ignored `.env` files; use `.env.example` as the template.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, no semicolons, and the existing ESM/TypeScript style. React components and files use PascalCase (for example, `CalendarBoard.tsx`); functions, variables, and utility modules use camelCase. Server tests use descriptive names ending in `.test.mjs`. Keep API and persistence changes aligned with the contracts in `docs/interfaces/` and run `pnpm lint` before submitting.

## Testing Guidelines

Tests use Node’s built-in `node:test` runner and live beside server code as `my-app/server/*.test.mjs`. Add focused regression coverage for changed API, persistence, workflow, or integration behavior. Run `pnpm test`, `pnpm lint`, and `pnpm build`; there is no separate coverage threshold configured.

## Commit & Pull Request Guidelines

History uses short, descriptive commit subjects, including both English and Chinese project descriptions; no formal Conventional Commits scheme is established. Keep commits focused and describe the user-visible or contract-level change. Pull requests should explain the problem, scope, validation commands and results, configuration or security impact, and screenshots for UI changes. Link the relevant issue or plan when one exists.

## Documentation and Safety

Keep formal documentation in `docs/` and implementation plans in `plans/`. Do not commit `.env`, database files, `data/`, `node_modules/`, or build output. Never place API tokens or model credentials in frontend code, logs, tests, or documentation.
