import fs from 'node:fs';
import path from 'node:path';

/**
 * 插件的数据落点：state、画像、反馈、登录态、收藏夹缓存。
 * 只做读写，不含任何推荐或播放规则。
 *
 * @param {{dataDir: string, cookieFile?: string, profileFile?: string}} options
 */
export function createStateStore({
  dataDir,
  cookieFile: cookieFileOption,
  profileFile: profileFileOption,
}) {
  const cookieFile = cookieFileOption || path.join(dataDir, 'cookies.json');
  const profileFile = profileFileOption || path.join(dataDir, 'profile.json');
  const feedbackLogFile = path.join(dataDir, 'feedback.jsonl'); // 追加式审计流水，不参与统计
  const feedbackStateFile = path.join(dataDir, 'feedback.json'); // 每首歌一条状态，最后写入者胜出
  const stateFile = path.join(dataDir, 'state.json');
  const folderFile = path.join(dataDir, 'agent-folder.json');

  fs.mkdirSync(dataDir, { recursive: true });

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
  // 手改或旧版本写坏的 state.json 不能让运行时到处判空：在边界处把列表补成数组
  for (const key of ['history', 'queue', 'recent']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
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
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(feedbackLogFile, JSON.stringify(record) + '\n', 'utf8');
  };

  // 旧版是追加流水，新版是「每首歌一条状态」；首次启动时迁移一次。
  if (!fs.existsSync(feedbackStateFile)) {
    const rows = readFeedbackLog();
    if (rows.length) {
      const map = {};
      for (const row of rows) {
        if (!row || !row.bvid) continue;
        // clear 是一条「取消标记」的流水，迁移时要把它前面的反馈删掉
        if (row.action === 'clear') delete map[row.bvid];
        else map[row.bvid] = row;
      }
      writeFeedbackState(map);
      console.log(
        `[bili-music] migrated ${rows.length} feedback rows -> ${Object.keys(map).length} track states`,
      );
    }
  }

  return {
    paths: {
      dataDir,
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
