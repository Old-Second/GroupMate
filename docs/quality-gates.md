# 质量闸门与验证入口

本文件说明仓库当前的自动闸门、它们各自覆盖什么，以及哪些验证入口只能手动触发。CI 定义在 `.github/workflows/ci.yml`，矩阵为 Node 22.23.1 与 24。

## 自动闸门（CI 必过）

| 闸门 | 命令 | 覆盖范围 |
| --- | --- | --- |
| Lint | `pnpm run lint` | `src/`、`test/`、`apps/`、`client/`、`model/`、`utils/`、`server/`（不含 `server/static/`）、`scripts/`、根入口文件 |
| 离线测试 | `pnpm test` | 先 `tsc` 编译 `src/` 与测试，再以单并发运行 `node:test` 全量离线套件 |
| `dist/` 漂移 | `node scripts/check-dist-drift.mjs` | 已提交的 `dist/` 是否与当前 `src/` 的编译结果一致 |
| 入口语法 | `node --check`（`index.js`、`guoba.support.js`、`apps/*.js`、`scripts/*.mjs`） | 不进入默认测试的脚本入口 |
| 空白错误 | `git diff --check` | 全历史范围的空白错误 |

## Lint 规则与空 catch 政策

配置在 `eslint.config.js`，使用 ESLint 与 `typescript-eslint` 的解析器。规则集刻意收窄：只报告在本仓库里无论风格如何都算错误的模式，因此可以当作必过闸门。格式不做检查；类型相关规则交给 `tsc -p tsconfig.json`（`strict`）与 `tsconfig.test.json`。

`no-empty` 是区分“刻意沉默”和“静默失败”的闸门：

- 块内有注释即通过，`catch {}` 不通过。日志、轮转、清理、落盘失败仍然可以被吞掉，但必须用注释写明原因。
- 存量的空块记录在 `eslint-suppressions.json` 里，不会让 CI 失败；新增的会。

`no-control-regex` 明确关闭：标识符与路径校验里出现控制字符正是为了拒绝它们。

### baseline 现状与收敛

`eslint-suppressions.json` 为 59 个文件、149 条：`no-empty` 133、`no-useless-escape` 8、`no-regex-spaces` 7、`no-constant-condition` 1。

收敛方式：

1. 修改某文件时顺手处理该文件里的条目——补注释说明为什么失败可以忽略，或改成真正的失败路径。
2. `pnpm run lint:prune` 会删掉已经不需要的抑制条目；提交这次变更即可缩小 baseline。
3. 新代码不得向 baseline 追加条目；需要空块时写注释，而不是 `--suppress-all`。

## 手动验证入口

以下入口不进 CI，原因写在各自一行里。它们都需要先 `pnpm run build`。

| 入口 | 为什么手动 |
| --- | --- |
| `pnpm run verify:phase6` / `verify:phase7` / `verify:phase7b` / `verify:phase7c` / `verify:phase7d` | 阶段验收编排，会重跑整套构建与测试并派生带 RSS 阈值的子进程，耗时数分钟且结果依赖宿主内存 |
| `pnpm run test:resources:phase6` / `test:resources:phase7` | 直接断言 RSS 上限（20–50 MiB），共享 CI 机器上不稳定 |
| `node scripts/measure-memory.mjs` | Phase 5 的 RSS 测量对，同样依赖宿主内存；CI 只做语法检查 |
| `pnpm run test:redis:phase6` | 需要 `GROUPMATE_REDIS_URL`；没有配置时只会返回 `skipped`，进 CI 不产生信号 |
| `pnpm run test:online:openai` | 需要真实 OpenAI-compatible 凭据，会产生实际费用；其纯函数部分已由 `test/unit/online-openai-smoke.test.js` 覆盖 |
| `scripts/diagnose-prefix-divergence.mjs`、`diagnose-prefix-shape.mjs`、`diagnose-system-instructions.mjs`、`measure-prefix-cache.mjs`、`measure-prefix-reorder-gain.mjs` | 对话前缀缓存的日志取证入口，参数是生产 `data/logs/groupmate/` 的 JSONL 目录，没有合成夹具可以在 CI 里跑；CI 只做语法检查 |

`scripts/audit-provider-surface.mjs`、`scripts/phase-6-resource-scenario.mjs`、`scripts/phase-7-resource-scenario.mjs`、`scripts/memory-scenario.mjs` 不需要单独入口：第一个由 `test/characterization/provider-surface.test.js` 在 `pnpm test` 里调用，后三个由对应的资源报告作为子进程派生。

## `dist/` 为什么需要漂移门禁

内存受限的部署主机直接消费已提交的 `dist/`，不在远端构建。只改 `src/` 而忘记重新构建并提交，部署出去的就是旧的运行代码，而测试仍然通过——`pnpm test` 会先重新构建 `dist/`，所以构建之后工作区是否干净，正好等价于“已提交的 `dist/` 与 `src/` 一致”。`git diff --check` 只检查空白错误，发现不了这种漂移。

闸门只读 Git 状态（`git ls-files -- dist` 与 `git status --porcelain --untracked-files=all -- dist`），不会重新构建、写入或回滚任何文件；`dist/` 未被跟踪或 Git 不可用时同样失败，而不是静默通过。本地修复方式是 `pnpm run build` 后提交 `dist/`。
