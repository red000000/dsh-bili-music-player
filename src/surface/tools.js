import fs from 'node:fs';
import path from 'node:path';

/**
 * 工具入口：把领域动作包装成 agent 可调用的四个工具。
 * 只负责参数形状与返回结构，业务规则不在这里。
 */

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];
const output = { schema: { type: 'object', additionalProperties: true }, render: textRender };

/**
 * @param {{ctx: object, state: object, store: object, feedbackOf: Function, profileSummary: Function,
 *   feedbackStats: Function, pickNext: Function, playBvid: Function, playByQuery: Function,
 *   submitFeedback: Function, dataDir: string, cookieFile: string, profileFile: string}} deps
 */
export function registerTools(deps) {
  const {
    ctx,
    state,
    store,
    feedbackOf,
    profileSummary,
    feedbackStats,
    pickNext,
    playBvid,
    playByQuery,
    submitFeedback,
    dataDir,
    cookieFile,
    profileFile,
  } = deps;

  ctx.tools.register({
    name: 'bili_music_play',
    description:
      '播放 B 站音乐。给 query 则搜索并播放；不给则按用户画像与历史反馈推荐一首。返回曲目信息与浏览器播放地址。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', description: '歌曲名/歌手，可省略' } },
    },
    output,
    async execute(args) {
      const track = args.query
        ? await playByQuery(String(args.query))
        : await (async () => {
            const pick = await pickNext();
            if (!pick) throw new Error('画像和在线搜索都没有找到可播放的曲目');
            return playBvid(pick.bvid, {
              reason: `推荐：${pick.artist || '未知'} · ${pick.title}`,
              source: pick.source || 'profile',
            });
          })();
      return { ok: true, track };
    },
  });

  ctx.tools.register({
    name: 'bili_music_feedback',
    description:
      '对当前播放曲目给出反馈：like（喜欢，会写入代理专属收藏夹）、skip（跳过）、dislike（不喜欢，永久排除且从待播队列移除）。一首歌只保留一个反馈，可改不可叠；反馈写入 feedback.json 并影响下一次推荐。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['like', 'skip', 'dislike'], description: '反馈类型' },
        reason: { type: 'string', description: '可选原因' },
      },
    },
    output,
    async execute(args) {
      return {
        ok: true,
        ...(await submitFeedback(String(args.action), String(args.reason || ''))),
      };
    },
  });

  ctx.tools.register({
    name: 'bili_music_status',
    description: '查看点歌助手状态：当前曲目、画像摘要、反馈统计。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    async execute() {
      const map = store.readFeedbackState();
      return {
        ok: true,
        current: state.current
          ? { ...state.current, feedback: feedbackOf(state.current.bvid) }
          : null,
        profile: profileSummary(),
        feedback: { total: feedbackStats().total },
        history: (state.history || [])
          .slice(0, 20)
          .map((entry) => ({ ...entry, feedback: map[entry.bvid]?.action || null })),
        paths: { dataDir, cookieFile, profileFile, feedback: store.paths.feedbackStateFile },
      };
    },
  });

  ctx.tools.register({
    name: 'bili_music_import',
    description:
      '导入 B 站登录 cookie 与画像文件到插件数据目录（从给定绝对路径复制），让点歌助手可用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cookieFile: { type: 'string', description: 'cookies.json 的绝对路径' },
        profileFile: { type: 'string', description: '画像 JSON 的绝对路径（可选）' },
      },
    },
    output,
    async execute(args) {
      const result = { ok: true, imported: [] };
      if (args.cookieFile) {
        const raw = fs.readFileSync(String(args.cookieFile), 'utf8');
        JSON.parse(raw); // 先校验是合法 JSON，再落盘
        fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
        fs.writeFileSync(cookieFile, raw, { mode: 0o600 });
        result.imported.push({ kind: 'cookie', to: cookieFile });
      }
      if (args.profileFile) {
        const raw = fs.readFileSync(String(args.profileFile), 'utf8');
        JSON.parse(raw);
        fs.mkdirSync(path.dirname(profileFile), { recursive: true });
        fs.writeFileSync(profileFile, raw);
        result.imported.push({ kind: 'profile', to: profileFile });
      }
      result.status = { cookie: fs.existsSync(cookieFile), profile: fs.existsSync(profileFile) };
      return result;
    },
  });
}
