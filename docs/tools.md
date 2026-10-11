# 工具能力与失败处理

工具经过当前请求意图、参数、现场权限、执行时限和投递回执检查。模型选中工具或聊天任务结束，不代表工具已经成功；图片、语音、视频等操作以确认的投递结果为准。

| 能力 | 工具 | 必要条件 |
| --- | --- | --- |
| 网络查询 | search、searchImage、website、github、searchMusic、searchVideo | 相应公网服务可用；配置需要密钥的搜索后端时须提供对应密钥 |
| 天气、群成员 | weather、queryUserinfo | 天气需要高德 Key；群成员查询限当前群可访问成员 |
| 图片、头像 | sendPicture、sendAvatar | 当前请求明确要求图片操作；地址可下载且符合公网、类型和大小限制 |
| 绘图、处理、识别 | draw、processPicture、imageCaption | 绘图适配器或 ap-plugin 入口；处理/识别需要有效的 HTTPS 扩展服务根地址 |
| 游戏面板 | queryGenshin、queryStarRail | 游戏适配器或对应 miao-plugin 入口，以及可查询的游戏资料 |
| 其他媒体 | sendMusic、sendVideo、sendAudioMessage、sendDice、sendRPS | 明确请求；音乐/视频使用已查到的标识；语音需要配置的合成适配器 |
| 群管理与转发 | editCard、jinyan、kickOut、setTitle、handleMsg、sendMessage | 明确操作和目标、当前身份与机器人实际权限；跨会话发送还受独立配置限制 |

缺少绘图、游戏、天气、识别或处理依赖时，不向模型提供相应能力。无效的可选图片服务地址不会阻断其他工具。入口存在只表示具备调用条件，不保证第三方服务或账户当前可用。

`sendPicture` 和 `sendAvatar` 每次最多发送四张，单张下载上限 8 MiB，下载与发送合计限制为 25 秒。下载确定失败的地址会被跳过；已经确认的图片不重复发送。部分成功会记录实际数量。QQ 已经开始发送但回执丢失时，结果保留为未知并停止后续发送，不自动重试。

`processPicture` 直接把处理结果发送到当前会话，无需再次调用 `sendPicture`。处理服务返回的内存图片或本地资源由宿主适配器接收，不作为公网地址交给模型重放。绘图、语音、视频、音乐、骰子和游戏面板同样保留投递未知结果。

网易云搜索兼容接口返回的 `text/plain` JSON，仍严格解析 JSON；普通错误文本不作为搜索结果。外部接口的超时、错误页、限额或失效媒体仍可能使工具失败。内容日志的网络诊断记录请求阶段、受控错误码及 HTTP 状态，不记录 URL、凭据或响应正文。
