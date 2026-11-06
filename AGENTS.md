# bili-music-player

DSH 插件：向 agent 暴露 `bili_music_play` / `bili_music_feedback` / `bili_music_status` / `bili_music_import`，并在 Web 端提供播放卡与音频代理。

profile: product

> 已以 AGPL 发布。Prettier、ESLint、`node --test` 冒烟与 CHANGELOG 均已就位，按 `product` 档维护；架构决策见 `docs/adr/`。

## 入口

| 文件 | 作用 |
|---|---|
| `index.js` | host 入口：薄导出 `src/plugin.js` |
| `src/` | host 源码：工具注册、`/bili-music/stream` 音频代理 |
| `client/` | client 源码：`bar.js` 编排，`audio-engine.js` 模块级单例，`player.js`/`loader.js` 外部系统，`parts/` 展示零件 |
| `client.js` | client 构建产物（由 bundler 生成，不手改） |
| `cordis.patch.yml` | bundle 声明 |
| `locale/` | 中英文案 |

## 约束

- 入口文件必须留在包根，宿主按 `package.json#exports` 解析；内部逻辑放 `src/`，根入口只做薄导出。
- 用户数据（画像、反馈）不写进项目目录，走插件数据目录。
- 改 `client/` 源码后重新构建生成 `client.js`；改 `src/` 后重启 DSH 才能生效。
- Client 侧由 bundler 打包为自包含产物：宿主只加载 bundle，入口与 chunk 不能同步 require 另一个相对 `client*.js` 产物；源码可以分目录，交付前必须构建。
- 提交前依次跑：`npm run lint`、`npm test`、`npm run build`，再 `node --check client.js`。
- 领域规则改动请在 `tests/*.test.mjs` 补一条冒烟；测试不联网，用假 store 与假 state。

## 已知边界

- 音频代理只服务已缓存的本地片段，Range 语义见 README。
- 推荐依赖 `tools/bili-music` 生成的画像，画像缺失时功能降级。
