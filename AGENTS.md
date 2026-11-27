# AGENTS.md

Entry file for AI coding agents working on `@fabersep/memory` (`fabersep/memory`).

## Project

`@fabersep/memory` is Layer 0 of the FaberSEP engineering context stack: a prefix-cache-first, Git-backed Markdown memory system with deterministic L0 compilation, read-only active memory + `pre-memory` staging, a 3-tool pure-JS BM25 MCP server, and deterministic zero-LLM import/migration CLI.

## Map

- **Users:** [README.md](README.md) is the plain-language, story-first entry for non-technical users; technical detail goes in [docs/guide.md](docs/guide.md), not the README.
- **Product:** [docs/master-prd.md](docs/master-prd.md)
- **Architecture:** [docs/architecture.md](docs/architecture.md)
- **Specs:** [docs/features/README.md](docs/features/README.md) (`01-core-memory` v0.1 and `02-metrics-and-stats` v0.2)
- **Source:** `src/` (TypeScript, ESM, zero runtime dependencies)
- **Tests:** `test/` (`node:test`, covering `01-core-memory` `AC-01`–`AC-20b2` and `02-metrics-and-stats` `02/AC-01`–`02/AC-24b`)

## Gates

- `npm test` must pass (`tsc -p tsconfig.json` + `node --test dist/test/*.test.js`) before any commit or PR.
- Zero runtime dependencies and zero native addons (`NG-01`).
- Every behavioral change must stay aligned with its approved feature `acceptance_criteria.md` (`01-core-memory` and `02-metrics-and-stats`).
