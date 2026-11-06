# tests

目录镜像 `src/` 与 `client/`，离线测试与联网回归分开。

## 离线测试（`npm test`）

不联网、不需要登录态，覆盖纯逻辑与组件渲染：

| 文件 | 覆盖 |
|---|---|
| `domain/recommendation.test.mjs` | 画像合并、时长过滤、会话护栏、在线候选过滤 |
| `domain/feedback.test.mjs` | 一歌一票、收藏夹同步、dislike 清理队列 |
| `adapters/manifest.test.mjs` | sidx 解析与损坏索引容错 |
| `adapters/state-store.test.mjs` | 状态落盘、cookie 头、反馈迁移、坏文件归一化 |
| `surface/routes.test.mjs` | 缓存 Range 响应、状态接口、错误码、诊断通道 |
| `client/player.test.mjs` | 媒体监听、seek 夹紧、ended 防抖、音量边界 |
| `client/audio-engine.test.mjs` | 模块级单例、状态写入、ended 订阅（切会话不重建播放器） |
| `client/playback-store.test.mjs` | 播放状态单一来源：合并更新、变化通知、退订 |
| `client/loader.test.mjs` | MSE 起播、整首兜底、同曲去重与失败重试 |
| `client/notice.test.mjs` | 浮层定位（相对播放条绝对定位，不撑大宿主滚动区） |
| `client/render.test.mjs` | 构建产物能注册并渲染出播放条 |

```sh
node --test --test-isolation=none "tests/**/*.test.mjs"
```

## 联网回归（`tests/integration/`）

真实访问 B 站与本地缓存，跑之前需要有登录态与画像：

```sh
node tests/integration/run-range.js
node tests/integration/run-manifest.js
node tests/integration/run-queue.js
node tests/integration/run-online.js
node tests/integration/run-search.js
node tests/integration/sim-picks.js
```
