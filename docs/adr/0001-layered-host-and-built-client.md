# 0001 插件分层与 client 构建

- Status: accepted
- Date: 2026-11-06
- Decider: 用户确认方案 B（client 源码分目录 + 构建），代理实施
- Scope: 持续规则

## Context

插件原先两个大文件：Host `src/plugin.js` 1171 行、Client `client.js` 856 行。工作区规范要求按入口 / 领域 / 机制 / 装配分层，并按抽象层级建子目录。

Client 侧还有一条硬约束：DSH 运行时以 lazy-CJS 加载预打包 bundle，`require()` 只解析平台模块、已物化记录、boot graph 行与已注册 factory，入口与 chunk 不能同步 require 另一个相对 `client*.js` 产物。因此 client 必须交付为单文件。

## Decision

1. Host 分层：`src/adapters/` 接外部世界（B 站 HTTP、收藏夹、音频缓存、清单解析、状态文件），`src/domain/` 放规则（推荐、播放、反馈），`src/surface/` 放 DSH 接口面（HTTP 路由、工具），`src/plugin.js` 是唯一同时认识三层的组合根。
2. 依赖注入代替闭包：领域模块通过参数拿依赖（store、state、searchMusic、relatedCandidates、videoInfo），不 import 适配器，保证依赖方向单向。
3. Client 分目录 + 构建：源码放 `client/`（`index.js` 注册、`bar.js` 组件、`diag.js`、`audio.js`），用 esbuild 打包成根目录 `client.js` 交付；构建产物提交进仓库，宿主只认这个文件。
4. 组件整体保留为一个模块：`bar.js` 是单个 React 组件闭包，拆成多个文件只能靠 prop 透传，收益低于风险，因此不拆；这条例外写在项目 `AGENTS.md`。

## Consequences

- 组合根 150 行左右，改播放规则不需要动路由，改路由不需要动规则。
- 领域逻辑可脱网测试：`tests/domain/recommendation.test.mjs` 用假 store 与假 state 覆盖画像合并、时长过滤、会话护栏；`tests/client/render.test.mjs` 用假 React 执行构建产物，抓住「搬代码漏变量」这类崩溃；`tests/client/loader.test.mjs` 用假 fetch 与 MediaSource 覆盖 MSE 起播、兜底与取消。
- Client 交付物必须由 `npm run build` 生成；直接改 `client.js` 会在下一次构建被覆盖。
- 构建引入 esbuild（约 10 MB 平台二进制）。这与 `code.md`「个人项目不引构建链」字面冲突，原因是 client 交付形态强制单文件；已向规范维护方提出口径确认（见 `tasks/2026-11-06-bili-music-restructure/notes/prompt-for-rules-owner.md`）。
- 备选方案：不分层保持单文件（违反目录要求、领域逻辑无法脱网测试）；自研极简打包脚本（重复造轮子）；client 不构建保持手写单文件（与目录要求冲突）。

## 客户端后续拆分（2026-11-06 追加）

按同一原则把 client 拆成「hook 工厂 + 外部系统 + 展示零件」：`bar.js` 只留状态与副作用编排，其余各管一件事。

| 文件 | 职责 |
|---|---|
| `client/loader.js` | 资源加载：MSE 分片流、整首 blob 兜底、看门狗与取消 |
| `client/player.js` | 音频外部系统：媒体监听、时长修正、seek、播放开关 |
| `client/audio-engine.js` | 模块级音频引擎：播放器/加载器单例与订阅，切会话不打断播放 |
| `client/hooks.js` | `useServerState`（轮询）、`useNotice`（浮层）、`useMode`（模式持久化） |
| `client/theme.js` | 颜色令牌、反馈动作定义、dock 样式注入 |
| `client/bar-boundary.js` | 播放条渲染错误的兜底界面 |
| `client/parts/buttons.js` | 图标按钮、反馈按钮、模式按钮 |
| `client/parts/progress.js` | 时间/加载百分比、进度条、调试读数 |
| `client/parts/history.js` | 播放历史面板与补反馈 |
| `client/parts/feedback.js` | 反馈区三个按钮 |
| `client/parts/notice.js` | 浮动提示与错误条 |

`bar.js` 由 999 行降到 474 行，剩余内容是组件状态、请求时序与区块摆放。

加载逻辑单独成 `loader.js` 而不是并进 `player.js`：player 管「元素上的事件与 seek」，loader 管「资源怎么到手」，两者互不认识；合并会让 player 同时依赖 fetch、MediaSource 与媒体事件，测试也得一起造假。
