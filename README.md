# B 站点歌助手（DSH 插件）

按你的 B 站音乐画像推荐歌曲，支持**软反馈**（喜欢/跳过/不喜欢，可给可不给），反馈累积后让下一次推荐更准；喜欢的歌只写入**代理专属收藏夹**。

## 能力

| 能力 | 说明 |
|---|---|
| `bili_music_play` | 给 `query` 则搜索并播放；不给则按画像 + 反馈推荐一首 |
| `bili_music_feedback` | `like` / `skip` / `dislike`；一首歌只保留一个反馈（可改），写 `feedback.json` + 审计流水 |
| `bili_music_status` | 当前曲目、画像摘要、反馈统计、**播放历史**、数据路径 |
| `bili_music_import` | 从绝对路径导入 cookie 与画像 JSON |
| 播放条 | 紧凑单行：⏮ ▶/⏸ ⏭ + 标题·歌手 + `0:12/5:43` + 可点击进度 + 模式 + 历史 + 反馈 |
| 音频代理 | `/bili-music/stream/<bvid>`：整首缓存到本地后按标准 Range 语义提供（200/206/416）；客户端优先走 Blob 播放 |

## 播放模式与历史

| 功能 | 行为 |
|---|---|
| 🔁 单曲循环 | 播完回到 0 秒重播当前曲（只影响自动播放，不拦截手动切歌） |
| ▶▶ 推荐连播 | 播完自动调 `/bili-music/next` 推荐下一首并续播（默认） |
| 🕘 历史 | 最近 50 首，每条可直接补/改反馈（不用等正在播） |
| ⏭ 下一首 | 从**播放队列**取下一首（队列空了现推荐），永远是没听过的歌 |
| ⏮ 上一首 | 回到真正的上一首（播放历史前一条）；到头提示「没有上一首歌了喵」 |
| 进度 | 显示 `当前/总时长`，点击任意位置跳转（服务端本地缓存 + 精确 Content-Range，seek 稳定） |

模式记在 `localStorage`（`bili-music-mode`），刷新后保留。

## 推荐连播的曲库

`/bili-music/next` 的候选来自两处：画像里的 `topSongs`（60 首）与在线搜索。**不用「最近 N 首」的滚动窗口去重**——窗口总会过期，听久了必然回到循环；改用打分：

```
硬护栏：最近 20 首绝不重播；dislike 永久排除
score = 画像分 × 置信度系数
      + 本曲 like×2.0
      + 同歌手 like×0.5 / dislike×(-0.8)
      × 近期性衰减：听过越近分越低（下限 0.15，不禁用）
      × 歌手多样性：同歌手在最近 5 首出现过则 ×0.55
抽样：按 score 加权随机
```

**探索配额**：即使画像里还有候选，也有 50% 概率优先给「没听过的」（`EXPLORE_RATE`）；画像里没有「完全没听过」的曲目时强制走在线搜索。

在线候选有两个来源：/x/web-interface/archive/related 相关推荐（用最近听过的歌当种子，找相似但没听过的）与多关键词搜索（Top 歌手 / 风格标签 / 泛风格词，随机 1–4 页）。搜索优先 WBI 接口，返回空时自动退回普通接口并静默 10 分钟；结果缓存 5 分钟，补队列只搜一轮，避免风控。

三个旋钮在 `src/plugin.js`：`NO_REPEAT`（会话护栏）、`RECENCY_FLOOR`（衰减下限）、`EXPLORE_RATE`（探索比例）。

想扩大曲库就重跑 `tools/bili-music profile` 并把新的 `profile.json` 导入。

## 技术选型：优先标准能力，不做无谓的自研补偿

| 问题 | 采用方案 | 为什么 |
|---|---|---|
| 播放与 seek | **MSE 边下边播**：服务端解析 fMP4 的 `sidx` 出分段表，客户端先追加 init 段即出声，其余分段按 Range 顺序追加 | 与视频网站同款方案：起播约 1 秒，分段来自稳定字节流，seek 可靠 |
| 兜底 | MSE 不可用时退回整首下载（Blob） | 保证任何情况下都有可 seek 的播放路径 |
| 音频落盘 | Node `fs` 流式下载 + 自建小缓存（40 首 LRU） | 无第三方依赖，行为可控 |
| HTTP Range | 自研 ~25 行解析（206 / 416 / 后缀范围） | `range-parser` 需要给 link 安装的 bundle 增加依赖与安装步骤，收益不足；解析逻辑已用 200/206/416 用例覆盖 |
| 媒体时长 | 仅在 `duration === Infinity` 时用 `currentTime = 1e101` 探测 | 业界通用 workaround，条件触发；正常文件不执行 |
| MP4 头修补 | **已删除** | 起因是怀疑 fMP4 时长缺失；实测 `mvhd` 时长正常，Blob 方案又已解决问题，属于无必要的补偿 |

诊断：默认关闭，点播放条上的时间文字才开启，日志写 `~/.dsh/bili-music/debug.log`（桌面版没有 DevTools）。

## 自动播放说明

`<audio>` 元素常驻页面（隐藏）。首次必须点一次 ▶ 取得浏览器用户手势；此后连播/循环在浏览器策略允许时自动继续，被拦截时提示「点一下 ▶ 继续」，不会误报。

- 播放到结尾后再点 ▶：先 `currentTime = 0` 再播，不会卡在末尾
- 元素进入 error 状态：点 ▶ 会先 `load()` 重试，并显示真实错误码（不再一律显示「浏览器拦截」）

## 边界（重要）

- **只写一个收藏夹**：`点歌助手`（私密，`privacy=1`）。用户的默认收藏夹、`music`、`怪` 等**永不改动**。
- **反馈是软的**：不点按钮不影响任何东西；`skip` 权重 -0.2 几乎无感，`dislike` 才会真正排除。
- 凭据与数据默认在 `~/.dsh/bili-music/`，文件权限 `0600`。

## 安装

1. 把本目录作为 bundle 安装到 web profile：
   - Settings → Plugins → 从本地目录安装，路径选本目录；或
   - `plugin_manager` 工具 `install_bundle`，`target` 为绝对路径
2. 重启 DSH Web（Host 半区模块只在启动时加载）
3. 首次使用导入凭据：
   ```
   bili_music_import({ cookieFile: "<cookies.json 绝对路径>", profileFile: "<画像 json 绝对路径>" })
   ```

## 数据布局（`~/.dsh/bili-music/`）

| 文件 | 内容 |
|---|---|
| `cookies.json` | B 站登录态（SESSDATA / bili_jct / DedeUserID） |
| `profile.json` | 音乐画像（由 `tools/bili-music profile` 生成） |
| `feedback.jsonl` | 反馈流水（追加式，可 r 重算） |
| `state.json` | 当前曲目与最近播放 |
| `agent-folder.json` | 代理收藏夹 id 缓存 |

## 推荐算法

```
score = 画像分 × 置信度系数
      + 本曲 liked×2.0 + disliked×(-1.5)
      + 同歌手 liked×0.5 + disliked×(-0.8)
排除：最近 30 条已播放、dislike 过的曲目
抽样：按 score 加权随机，避免每次都同一首
```

## 开发

离线测试台（桩模块 + 假 ctx，真实打 B 站接口）：

```sh
node .tmp/plugin-test/run.js
```

覆盖：工具注册、搜索点歌、画像推荐、like 写回收藏夹、skip、Range 音频代理。

## 已知限制

- `tname`/`tags` 在匿名 `view` 里可能为空，标签画像依赖 `tools/bili-music` 采集。
- 音频直链约 2 小时过期；代理每次请求现取，长播会周期性重取。
- 浏览器可能拦截自动播放，需点一次 ▶。

## 安装与本地开发

插件已「正规化」为 profile 内自带的 vendor 包，不再依赖 workspace 路径：

```
~/.dsh/profiles/desktop/
├─ vendor/dsh-bili-music-player/      # 包本体（index.js / src / client.js / locale / icon）
├─ node_modules/dsh-bili-music-player  # pnpm 从 vendor 安装
└─ package.json  dependencies: { "dsh-bili-music-player": "file:./vendor/bili-music-player" }
```

改动后同步到 profile（改完需重启 DSH 生效）：

```powershell
 = "C:\Users\Qq320\.dsh\profiles\desktop"
Copy-Item .\projects\bili-music-player\* "\vendor\bili-music-player" -Recurse -Force
Set-Location ; pnpm install
```

这样换机只需要带上 `vendor/bili-music-player` 与 `package.json` 的依赖项，不再依赖工作区。

## 发布

当前状态：**已具备发布条件，尚未发布**。包名 `dsh-bili-music-player`（npm 上未被占用），作者 `RED`，MIT。

### 待办

1. 需要 npm 账号（`npm login`，或配置 `NPM_TOKEN`）
2. 首次发布后，可再补 `repository` 字段（当前不发布 remote）

### 发布步骤（npm）

```sh
npm login                                  # 先有 npm 账号
npm pack --dry-run                         # 确认 11 个文件
npm publish --access public                # 包名已是 dsh-bili-music-player
```

### 发布步骤（git，不经过 npm）

```sh
dsh plugin --profile desktop add github:你的账号/bili-music-player
```

要求仓库根目录就是本包（package.json 带 dsh.bundle.patch）。

### 安装后

```sh
# 重启 DSH，然后导入凭据
bili_music_import({ cookieFile: "...", profileFile: "..." })
```

### 没有 registry 时的分发方式

npm/GitHub 暂时不可用也能分发：`npm pack` 产出的 tarball 就是完整包。

```sh
npm pack                     # 生成 dsh-bili-music-player-0.1.0.tgz
```

安装方把它解包到 profile 的 vendor 目录，再 `pnpm install`：

```powershell
 = "\C:\Users\Qq320\.dsh\profiles\desktop"
tar -xzf dsh-bili-music-player-0.1.0.tgz -C "\\vendor"
Rename-Item "\\vendor\package" "dsh-bili-music-player"
# 在 \\package.json 的 dependencies 里加：
#   "dsh-bili-music-player": "file:./vendor/dsh-bili-music-player"
# 并在 dsh.profile.bundles 里追加 "dsh-bili-music-player"
Set-Location \; pnpm install
```

这与 npm 安装的产物一致（同一份 tarball），只是少了 registry 这一跳。
