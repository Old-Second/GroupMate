# Repository Guidelines

## Project Structure & Module Organization

This repository is an ES-module Yunzai plugin. `index.js` discovers and loads command handlers from `apps/`. Provider integrations and shared conversation logic live in `client/` and `model/`; reusable helpers, tools, TTS adapters, and API wrappers belong in `utils/`. The optional Fastify management UI is under `server/`, with compiled browser assets in `server/static/`. Keep templates and help content in `resources/`, example settings in `config/config.example.json`, and dependency patches in `patches/`.

## Build, Test, and Development Commands

- `pnpm install` installs required and optional dependencies; Node.js 18 or newer is recommended.
- `pnpm test` runs the deterministic offline `node:test` suite with concurrency 1.
- Run the plugin from a Yunzai checkout at `plugins/chatgpt-plugin`, then restart Yunzai to exercise changes. This package has no standalone `start` or `build` script.
- `node --check apps/chat.js` performs a quick syntax check on a changed JavaScript file.
- `git diff --check` catches whitespace errors before submission.

Do not rebuild or hand-edit files in `server/static/` unless the corresponding management UI source and build process are available.

## Coding Style & Naming Conventions

While touching legacy JavaScript, preserve its existing style: two-space indentation, single quotes, no semicolons, and a space before function parentheses (`async sendMessage ()`). New and refactored code must use TypeScript with ESM `import`/`export` and project-wide compiler and lint settings. Name classes and client/tool files in PascalCase (`BaseClient.ts`, `WeatherTool.ts`), functions and variables in camelCase, and command-handler files in lowercase or snake_case. Keep provider-specific behavior in its adapter rather than adding branches to shared utilities.

## TypeScript Migration Policy

- TypeScript is the required language for all new or refactored source code wherever the host runtime and toolchain can reasonably support it. This includes the agent kernel, application handlers, adapters, tools, shared utilities, tests, and project-owned build or migration scripts.
- Migrate legacy JavaScript incrementally as each module is refactored; do not perform blind extension-only renames. Preserve observable behavior with characterization tests and keep the plugin compatible with the Yunzai host and its supported Node.js runtime.
- Establish a single TypeScript build/runtime path before switching entry points. TypeScript must become the source of truth; do not maintain independently editable `.ts` and `.js` copies of the same module.
- JavaScript may remain only when an external host interface, configuration format, generated output, vendored dependency, or unavailable build path genuinely requires it. Document such exceptions close to the file or in the relevant refactoring record.
- Do not hand-edit compiled JavaScript. Commit generated JavaScript only when deployment cannot consume TypeScript or build it safely on the memory-constrained remote host; otherwise keep build artifacts out of version control.

## Testing Guidelines

The repository uses an offline `node:test` suite through `pnpm test`; no coverage threshold is configured. For every change, run the focused tests, the full offline suite, syntax checks on touched files, and `git diff --check`. Real provider and QQ checks remain explicit, separately authorized gates. When they are run, record the exact bot command, provider, and observed result.

## Commit & Pull Request Guidelines

Use concise prefixes such as `fix:` and `feat:` followed by a focused Chinese description; add the related issue or PR number when available, for example `fix: 处理历史记录已被删除的情况 (#767)`. Keep commits scoped to one behavior. Pull requests should explain the user-visible change, list configuration or compatibility effects, link relevant issues, and include verification notes. Add screenshots for management-panel or rendered-message changes.

## Security & Configuration

Never commit API keys, tokens, cookies, chat history, or generated data. Real configuration files under `config/` are ignored; update `config/config.example.json` only with safe placeholders when introducing a setting.

## Deployment Context & Remote Safety

- This checkout was copied from the SSH host alias `my`. Its deployed counterpart is `/root/trss-Yunzai/plugins/chatgpt-plugin`.
- The plugin runs inside the QQ bot project at `/root/trss-Yunzai`; architecture and compatibility decisions must account for that host project, not just this standalone checkout.
- The remote server has extremely limited memory. Keep remote inspection and verification low-cost and narrowly scoped. Do not run dependency installation, builds, broad test suites, full-tree scans, or other memory-intensive commands on the remote host.
- Treat the remote host as read-only unless the user explicitly authorizes a deployment or remote edit. Develop and perform lightweight static verification locally first.
- Treat the current modified, deleted, and newly added functional source files as the customization baseline to preserve during refactoring. Do not discard or overwrite those changes unless the user explicitly approves it.
- Keep commits narrowly scoped and stage only reviewed paths explicitly. Never use broad staging such as `git add -A`; exclude runtime data, real configuration, generated images, databases, native binaries, and other unrelated artifacts.
- The refactoring target is an agent architecture close to current industry-leading systems. Base major design choices on up-to-date primary-source research while preserving existing custom behavior and fitting the remote server's strict resource limits.
- Use a self-built lightweight, standards-aligned agent kernel as the selected architecture. Do not integrate another AI SDK for now; existing model providers and tools must remain behind project-owned adapter interfaces.
- A long-term memory system is a required future subsystem, but it is outside the first implementation phase. Define stable memory interfaces, provenance, consent, user/group isolation, and migration boundaries now so it can be added later without replacing the agent kernel.
- The active provider scope is OpenAI-compatible API only. Keep the project-owned model adapter boundary so Anthropic API or other providers can be added later if needed, but do not integrate them now.
- During this refactor, remove existing non-OpenAI-compatible provider implementations, commands, configuration schema fields, example settings, and management UI entries. Do not rewrite or delete unknown keys from the user's ignored real configuration file; obsolete real-config fields may remain unused.

## Product Identity & Refactoring History

- The primary product role is a natural, ordinary participant in QQ groups: it should converse like a group member, perform authorized group-management actions, and complete simple tool-backed tasks without behaving like an external command console.
- The confirmed project name is `GroupMate`, and the refactoring branch is `groupmate`. The project name reflects its primary identity as a capable QQ group member rather than an external command console.
- The canonical GitHub repository is `https://github.com/Old-Second/GroupMate`. Keep the original `ikechan8370/chatgpt-plugin` repository only as the upstream history reference.
- All new-branch commits must use `Old-Second <oldsecond2@qq.com>` as both author and committer identity. Do not use the machine-wide Baidu commit identity for this repository.
- Before implementation begins, create and switch to the `groupmate` branch. Branch names for this project must not contain `codex`.
- Preserve the current `v2` branch as the historical baseline. On the new project branch, retain the entire legacy project state as one aggregated snapshot commit before adding refactoring commits.
- The aggregated legacy root is `3a71182c` and preserves the runtime-relevant customization baseline from `caf7c4c`; obsolete generated, duplicate, and non-runtime files are intentionally excluded. The `groupmate` and `v2` histories intentionally have no common parent; never merge an upstream branch into `groupmate` without an explicit patch-level review.
- Commit messages must keep a conventional type prefix such as `feat:` or `docs:`, but the descriptive text after the prefix must be written in Chinese.
- Keep phase roadmaps, research, specs, implementation plans, review reports, acceptance checklists, and raw baseline evidence as local-only working material. Do not commit them. Promote only stable user, deployment, architecture, API, or contributor documentation into project history.
- Use `https://github.com/yaowan233/nonebot-plugin-ai-groupmate` as a product and architecture reference for group cognition, proactive reply decisions, long-term memory, learned group culture and memes, tool extension, execution budgets, caching, and tests.
- The reference project is inspiration and comparison material, not a dependency or a codebase to transplant. Keep the selected self-built kernel and OpenAI-compatible-only provider scope; do not introduce LangChain. Check licensing and preserve required attribution before reusing any implementation detail.
