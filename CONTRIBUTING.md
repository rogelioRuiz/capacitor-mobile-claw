# Contributing to Mobile Claw

Thanks for your interest in contributing! This guide will help you get set up and understand our development workflow.

## Prerequisites

- **Node.js** >= 22
- **npm** (comes with Node.js)
- **Android Studio** and/or **Xcode** (for building the reference app on device)
- **Git**

## Getting Started

```bash
# Clone the repo
git clone https://github.com/rogelioRuiz/capacitor-mobile-claw.git
cd capacitor-mobile-claw

# Install dependencies
npm install

# Build the plugin
npm run build

# Run unit tests
npm test
```

## Project Structure

```
src/                    # TypeScript plugin source (compiled to dist/esm/)
examples/reference-app/ # Complete Vue 3 demo app
test/                   # Unit and E2E tests
docs/                   # Extended documentation
```

Key files:
- `src/engine.ts` — `MobileClawEngine` — thin native bridge (~490 lines)
- `src/definitions.ts` — All TypeScript interfaces and event types
- `src/mcp/` — MCP server, transports, and device tool types

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/esm/` |
| `npm run build:watch` | Compile in watch mode |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run E2E tests (requires `ANTHROPIC_API_KEY`) |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Check code with Biome |
| `npm run lint:fix` | Auto-fix lint and format issues |

## Running the Reference App

```bash
cd examples/reference-app
npm install
npm run cap:build        # vite build + cap sync

# Android
npx cap add android      # first time only
npx cap open android     # opens in Android Studio — build & run

# iOS
npx cap add ios          # first time only
npx cap open ios         # opens in Xcode — build & run
```

## Making Changes

### 1. Create a branch

```bash
git checkout -b feat/my-feature
```

### 2. Make your changes

- Follow existing code conventions (TypeScript strict, ESM, single quotes, no semicolons)
- Biome handles formatting — run `npm run lint:fix` before committing
- Add or update tests for your changes

### 3. Add a changeset

If your change affects the published npm package, add a changeset:

```bash
npx changeset
```

This will prompt you to describe the change and select a semver bump (patch, minor, major). The changeset file is committed with your PR and used to generate changelog entries on release.

Skip this step for docs-only or CI-only changes.

### 4. Commit with a conventional message

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(engine): add iOS background mode support
fix(mcp): handle transport disconnect gracefully
docs: update bridge protocol reference
chore(deps): update @capacitor/core to 8.2.0
```

Scopes: `engine`, `mcp`, `tools`, `app`, `docs`, `ci`, `deps`

### 5. Open a pull request

Push your branch and open a PR against `main`. The CI pipeline will run lint, typecheck, and tests automatically.

## Adding a New Device Tool

See [docs/creating-tools.md](docs/creating-tools.md) for a step-by-step guide to implementing a `DeviceTool`.

## Code Style

We use [Biome](https://biomejs.dev/) for both linting and formatting. The config lives in `biome.json`. Key rules:
- 2 spaces, no tabs
- Single quotes
- No semicolons
- 120 character line width
- Trailing commas

Run `npm run lint:fix` to auto-fix most issues.

## Reporting Issues

- **Bugs**: Use the [bug report template](https://github.com/rogelioRuiz/capacitor-mobile-claw/issues/new?template=bug_report.yml)
- **Features**: Use the [feature request template](https://github.com/rogelioRuiz/capacitor-mobile-claw/issues/new?template=feature_request.yml)
- **Security**: See [SECURITY.md](SECURITY.md) — do NOT use public issues for vulnerabilities

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please be respectful and constructive.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
