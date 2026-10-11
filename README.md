# GroupMate

GroupMate 是一个运行在 Yunzai 体系中的 QQ 群原生交互项目。它希望像普通群友一样自然参与交流，在明确授权后协助管理群聊，并通过工具完成简单任务，而不是把群聊变成命令控制台。

> GroupMate 正在从定制化的 `chatgpt-plugin` 运行基线独立重构，目前不是稳定发布版。现有旧版兼容代码仍在逐步迁移，目标架构和当前实现之间可能暂时存在差异。

## 设计方向

- 自建轻量、可测试、可回滚的运行内核，不接入其他 AI SDK。
- 模型边界收敛为 OpenAI-compatible API，同时保留项目自有适配器接口。
- 所有新增和重构代码使用 TypeScript；旧 JavaScript 随模块重构逐步迁移。
- 工具调用必须经过参数校验、权限策略、超时、输出限制和审计边界。
- 优先适配低内存部署环境，不引入不必要的常驻服务。
- 长期记忆是后续必建子系统，需要支持来源、授权、隔离、更正、删除和资源上限。

## 当前状态

当前仍保留待迁移的旧版会话与工具执行循环，但模型边界已经完成收窄：运行时、命令、配置示例、管理界面和依赖仅保留项目自有的 OpenAI-compatible 路径。旧 Provider 的真实配置字段不会被主动改写，但已停止读取且无法重新启用。下一阶段将建立项目自有的请求、会话、上下文和存储契约。

未经单独授权，本项目的开发流程不会连接真实模型、操作 QQ、部署远程服务器或重启机器人。

## 环境要求

- Node.js 22.23.1 或更高版本（需要内置 SQLite 的 FTS5 支持）；推荐使用当前 Node.js 24 LTS
- pnpm 10
- 可加载 Yunzai 插件的运行环境，例如 TRSS-Yunzai

项目没有独立的启动命令，必须由 Yunzai 加载。插件目录使用 `plugins/GroupMate`，运行时会根据实际安装位置解析配置、模板和静态资源。

## 安装

在 Yunzai 根目录执行：

```bash
git clone https://github.com/Old-Second/GroupMate.git ./plugins/GroupMate
cd ./plugins/GroupMate
pnpm install --frozen-lockfile
```

安装后按照所用 Yunzai 的方式加载或重启机器人。生产部署、配置迁移和重启应当先确认回滚方案，并避免在低内存服务器上执行不必要的构建或全量扫描。

## 配置与安全

安全的配置示例位于 `config/config.example.json`。真实配置、API Key、Cookie、聊天记录和运行数据不得提交到 Git。推荐通过兼容的管理面板维护配置；重构过渡期内的旧 Provider 字段不代表 GroupMate 的长期配置契约。

## 本地验证

```bash
pnpm test
pnpm test:unit
pnpm test:characterization
git diff --check
```

默认测试完全离线并以单并发执行。`pnpm test:online:openai` 仅用于明确配置并主动启用后的 OpenAI-compatible 连通性检查，不属于默认测试。

## 主要目录

- `apps/`：Yunzai 命令和事件入口。
- `client/`、`model/`：待迁移的旧版模型、会话和运行逻辑。
- `utils/`：工具、API 包装、渲染和通用能力。
- `server/`：可选管理服务及其当前运行所需的静态资源。
- `resources/`：帮助页、回复模板、图像和其他运行资源。
- `test/`：离线单元测试与旧版行为表征测试。
- `scripts/`：有界审计、资源测量和显式在线检查入口。

## 来源与许可

GroupMate 是对 [`ikechan8370/chatgpt-plugin`](https://github.com/ikechan8370/chatgpt-plugin) 的独立重构与延续，使用 GNU GPL v3 许可证。项目来源、保留历史和参考项目说明见 [NOTICE](NOTICE.md)。

### 群参与策略与版本更新

`participationMode` 默认是 `legacy`，沿用既有称呼、概率、反击和撤回设置。设为 `shadow` 时，仅将新参与策略的决定与现有策略比对，记录有界计数；实际回复仍由现有策略决定，不增加模型调用、工具执行或群消息。

`active` 仅在 `participationActiveGroups` 指定的群中启用，空列表不启用任何新群；其他群继续使用既有策略。仍需开启随机参与，并服从禁用群设置。受控群响应真实 @、句首称呼或已识别的机器人别名；成功投递后两分钟内可响应同一发言人的续问。单独的感谢、发给别人的消息和冷启动随机插话保持沉默。续问使用现有共享容量，繁忙时不排队；每群每小时最多 6 次、全局最多 30 次，两次受控续问至少间隔 30 秒。明确点名沿用现有排队和任务预算。

参与资格不授予工具权限。配置、成员或资料失效时仍按现有权限边界停止；受控参与任务重启后需要重新发起，成功答复的实际投递才建立新的续聊资格。

主人发送原有更新或强制更新命令时，会收到当前版本和更新说明。发布由维护者完成本地验证后，从 `groupmate` 分支按受控部署流程执行。


群文化文字提案为可选试点，默认关闭。成员可提议主题偏好、语言约定和梗说明，由另一位当前管理员审核；提案和审核均不代表全群共识。配置、治理、有效期和关闭方法见 [群记忆说明](docs/group-memory.md)。
