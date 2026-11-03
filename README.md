# B 站音乐点歌助手

DSH 插件：用你的 B 站听歌画像在会话里点歌，播放时给软反馈，推荐随反馈更新。

## 安装

```sh
dsh plugin --profile desktop add github:red000000/dsh-bili-music-player
```

重启 DSH，然后导入登录态与画像（文件留在本机，不上传）：

```js
bili_music_import({ cookieFile: "C:/path/cookies.json", profileFile: "C:/path/profile.json" })
```

`desktop` 换成你的实际 profile 名。

## 使用

- 让 agent 点歌：`帮我放首周杰伦`
- 播放条：上一首 / 播放暂停 / 下一首、可拖进度、单曲循环或推荐连播、播放历史
- 反馈：👍 喜欢、⏭ 跳过、👎 不喜欢。一首歌只保留一个反馈，可以改
- 喜欢会写进插件自建的私密收藏夹「点歌助手」，不会动你已有的收藏夹

## 推荐怎么工作

- 画像是收藏、历史、点赞、稍后再看的加权结果，收藏权重最高
- 最近听过的降权但不禁用，同歌手近期出现过也会降权
- 画像里没有没听过的歌时，自动去 B 站搜索与相关推荐找新的
- 「不喜欢」的歌永久排除

## 数据在哪

| 位置 | 内容 |
|---|---|
| `~/.dsh/bili-music/cookies.json` | B 站登录态 |
| `~/.dsh/bili-music/profile.json` | 听歌画像 |
| `~/.dsh/bili-music/feedback.json` | 反馈 |
| `~/.dsh/bili-music/cache/` | 音频缓存，40 首上限 |

画像由 `tools/bili-music` 采集生成，反馈直接叠加在画像之上，不用重新采集。

## 开发

- `index.js` 是入口，Host 逻辑在 `src/plugin.js`，Web 播放条在 `client.js`
- 改完做语法检查：`node --check index.js; node --check client.js`
- 回归脚本在 `tests/`，跑之前需要有登录态与画像

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：个人使用、研究、教学、公益与其它非商业用途可自由使用、修改和分发，保留版权声明即可。**商业用途需要作者书面授权**，请开 issue 说明场景。

## 致谢

- [DeepSeek](https://github.com/deepseek-ai/deepseek-harness) — 提供 DSH 与模型能力，本仓库的代码与文档由 AI 协作完成
- 参与者：DeepSeek-V4.1-Flash 1017（实现与文档）
- 贡献者：RED（作者、需求与验收）

