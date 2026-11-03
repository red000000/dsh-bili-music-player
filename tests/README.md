# tests

手动回归脚本，不参与 CI（项目目前 `profile: tool`，见 `../AGENTS.md`）。

## 运行

```sh
node tests/run-range.js     # 音频缓存 + Range 语义（200 / 206 / 416 / 后缀范围）
node tests/run-online.js    # 画像池耗尽时的在线兜底
node tests/run-queue.js     # 播放队列：下一首取新歌、上一首回历史
node tests/run-manifest.js  # MSE 分段清单：init/segment 的字节范围与时长
```

两个脚本都会：

- 用假 `ctx`（只实现 `effect` / `tools.register` / `webServer.register`）挂载插件
- 起一个临时 HTTP 服务转发 `/bili-music/*` 请求
- 真实访问 B 站接口与本地缓存

## 前置

- `.tmp/bili-music/cookies.json` 里要有有效登录态（`node tools/bili-music/bili-music.js login`）
- `data/bili-music-profile-*.json` 里要有画像（`node tools/bili-music/bili-music.js profile`）

## 注意

- 会写 `data/` 与 `.tmp/` 下的缓存，不会改 B 站账号数据（除 `like` 写入代理收藏夹）
- `run-online.js` 会把画像全部曲目塞进「已播放」，用来模拟池子耗尽
