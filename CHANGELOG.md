# Changelog

## 0.2.0 — 2026-11-06

### 变更

- Host 按层拆分：src/adapters、src/domain、src/surface，src/plugin.js 只做装配（1171 → 190 行）
- Client 源码移到 client/，用 esbuild 构建出 client.js；运行时由 loader 注入 react
- 新增 Prettier、ESLint 与 node --test 冒烟测试；补 ADR 记录分层与构建决策
- 领域逻辑（推荐、播放、反馈）可脱离宿主与网络单测

### 说明

- 对外接口与行为不变，升级不需要改配置
- 改 client/ 后必须运行 npm run build 重新生成 client.js

## 0.1.0 — 2026-10-31

首个可用版本。

### 新增

- Host 工具：`bili_music_play` / `bili_music_feedback` / `bili_music_status` / `bili_music_import`
- 播放条（composer dock）：播放/暂停、上一首/下一首、进度（可点击跳转）、播放模式、播放历史
- 软反馈：`like` / `skip` / `dislike`，**一首歌只保留一个反馈**（可改），选中项在按钮上打勾
- 播放模式：单曲循环 / 推荐连播（播完自动续播）
- 音量滑条与封面缩略图
- 音频本地缓存（上限 40 首，LRU）+ 标准 Range 语义（200 / 206 / 416）
- 客户端 Blob 播放，seek 不依赖 HTTP Range
- 画像池耗尽或每连续 8 首后，自动按 Top 歌手/标签在线补充曲目
- 播放历史 50 条，支持对历史曲目补/改反馈

### 写回边界

- 只向代理自建的**私密**收藏夹「点歌助手」写入；用户既有收藏夹（默认 / music / 怪 / 哄up）没有任何写路径

### 修复

- 切歌时旧音频未停止，出现「新标题 + 旧声音」
- 进度条 seek 后回到开头（fMP4 + HTTP Range）
- 音源直链过期导致下载失败后卡死（现在会重取直链重试）
- 连续点上下首导致请求叠加
