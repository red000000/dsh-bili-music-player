# Changelog

## 0.2.1 — 2026-11-06

### 变更

- Client 按职责拆成 loader / player / hooks / parts，`client/bar.js` 只做编排（999 → 516 行）
- 已标记的反馈按钮再点一次可取消标记（原来只提示「已经是这个反馈了」）
- 加载链路补离线测试：MSE 起播、整首兜底、同曲去重、失败重试

### 修复

- 浮动提示与错误条改为相对播放条绝对定位：宿主给输入框加了 `will-change: transform`，`fixed` 浮层会以输入框为包含块，被丢到下方几百像素处、撑大会话滚动区（表现为整块会话跳上去、下面一片空白）
- 已缓存的音频不再为每次 Range 请求访问 B 站接口，接口不可用时也能放本地缓存
- sidx 索引损坏或缺字节时返回 null，不再让播放链路抛错
- `state.json` 的 history / queue / recent 在加载时归一化成数组
- 相关推荐的候选过滤收回领域层，组合根不再前向引用 recommendation
- 收藏夹远端交互移出组合根，改由 `adapters/agent-folder.js` 承担
- `/prev` 现在读完请求体，避免 keep-alive 连接上残留数据
- `/debug` 保留原始日志文本，不再二次序列化
- 路由读取请求体的异常纳入 try，读失败也返回 JSON 而不是抛错

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
