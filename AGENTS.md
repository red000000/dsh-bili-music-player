# bili-music-player

DSH 插件：向 agent 暴露 `bili_music_play` / `bili_music_feedback` / `bili_music_status` / `bili_music_import`，并在 Web 端提供播放卡与音频代理。

profile: tool

> 尚未发布，暂按 `tool` 档；升级为 `product` 时补 `tests/`、`CHANGELOG.md` 与 Prettier/ESLint 配置。

## 入口

| 文件 | 作用 |
|---|---|
| `index.js` | host 侧：注册工具、`/bili-music/stream` 音频代理 |
| `client.js` | Web 侧：播放卡、按钮、模式切换 |
| `cordis.patch.yml` | bundle 声明 |
| `locale/` | 中英文案 |

## 约束

- 入口文件必须留在包根，宿主按 `package.json#exports` 解析；内部逻辑放 `src/`，根入口只做薄导出。
- 用户数据（画像、反馈）不写进项目目录，走插件数据目录。
- 改 `client.js` 后需要重建客户端模块；改 `index.js` 后重启 DSH 才能生效。
- 提交前至少做语法检查：`node --check index.js` 与 `node --check client.js`。

## 已知边界

- 音频代理只服务已缓存的本地片段，Range 语义见 README。
- 推荐依赖 `tools/bili-music` 生成的画像，画像缺失时功能降级。
