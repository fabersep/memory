# AGENTS.md

Entry file for AI coding agents working on `@fabersep/memory` (`fabersep/memory`).

## Project

`@fabersep/memory` is Layer 0 of the FaberSEP engineering context stack: a prefix-cache-first, Git-backed Markdown memory system with deterministic L0 compilation, read-only active memory + `pre-memory` staging, a 3-tool pure-JS BM25 MCP server, and deterministic zero-LLM import/migration CLI.

## Map

- **Product:** [docs/master-prd.md](docs/master-prd.md)
- **Architecture:** [docs/architecture.md](docs/architecture.md)
- **Specs:** [docs/features/README.md](docs/features/README.md) (core v0.1 spec: [docs/features/01-core-memory/prd.md](docs/features/01-core-memory/prd.md) and [acceptance_criteria.md](docs/features/01-core-memory/acceptance_criteria.md))
- **Source:** `src/` (TypeScript, ESM, zero runtime dependencies)
- **Tests:** `test/` (`node:test`, covering all BDD scenarios `AC-01`–`AC-20b2`)

## Gates

- `npm test` must pass (`tsc -p tsconfig.json` + `node --test dist/test/*.test.js`) before any commit or PR.
- Zero runtime dependencies and zero native addons in v0.1 (`NG-01`).
- Every behavioral change must stay aligned with `docs/features/01-core-memory/acceptance_criteria.md`.
