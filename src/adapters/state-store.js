import fs from 'node:fs';
import path from 'node:path';

/**
 * 插件的数据落点：state、画像、反馈、登录态、收藏夹缓存。
 * 只做读写，不含任何推荐或播放规则。
 *
 * @param {{base: string, cookieFile?: string, profileFile?: string}} options
 */
export function createStore({
  base,
  cookieFile: cookieFileOption,
  profileFile: profileFileOption,
}) {
  const cookieFile = cookieFileOption || path.join(base, 'cookies.json');
  const profileFile = profileFileOption || path.join(base, 'profile.json');
  const feedbackLogFile = path.join(base, 'feedback.jsonl'); // 追加式审计流水，不参与统计
  const feedbackStateFile = path.join(base, 'feedback.json'); // 每首歌一条状态，最后写入者胜出
  const stateFile = path.join(base, 'state.json');
  const folderFile = path.join(base, 'agent-folder.json');

  fs.mkdirSync(base, { recursive: true });

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  };

  /** 登录态 cookie 罐；没有文件时返回空对象，由调用方决定是否报错。 */
  const cookies = () => readJson(cookieFile, {});
  const cookieHeader = () => {
    const jar = cookies();
    return Object.entries(jar)
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  };

  const state = readJson(stateFile, { current: null, playedAt: null });
  const saveState = () => writeJson(stateFile, state);

  const readFeedbackState = () => readJson(feedbackStateFile, {});
  const writeFeedbackState = (map) => writeJson(feedbackStateFile, map);

  const readFeedbackLog = () => {
    try {
      return fs
        .readFileSync(feedbackLogFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const appendFeedbackLog = (record) => {
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(feedbackLogFile, JSON.stringify(record) + '\n', 'utf8');
  };

  // 旧版是追加流水，新版是「每首歌一条状态」；首次启动时迁移一次。
  if (!fs.existsSync(feedbackStateFile)) {
    const rows = readFeedbackLog();
    if (rows.length) {
      const map = {};
      for (const row of rows) if (row && row.bvid) map[row.bvid] = row;
      writeFeedbackState(map);
      console.log(
        `[bili-music] migrated ${rows.length} feedback rows -> ${Object.keys(map).length} track states`,
      );
    }
  }

  return {
    paths: {
      base,
      cookieFile,
      profileFile,
      feedbackLogFile,
      feedbackStateFile,
      stateFile,
      folderFile,
    },
    readJson,
    writeJson,
    cookies,
    cookieHeader,
    state,
    saveState,
    readFeedbackState,
    writeFeedbackState,
    readFeedbackLog,
    appendFeedbackLog,
    readProfile: () => readJson(profileFile, null),
  };
}
