/**
 * 代理专属收藏夹：唯一的远端写入目标，始终建成私密（privacy=1），
 * 只操作标题匹配的那一个，绝不碰用户既有收藏夹。
 *
 * @param {{bili: Function, cookies: () => object, videoInfo: Function,
 *   readJson: Function, writeJson: Function, folderFile: string, title: string}} deps
 */
export function createAgentFolder({
  bili,
  cookies,
  videoInfo,
  readJson,
  writeJson,
  folderFile,
  title,
}) {
  /** 取收藏夹：先读缓存，再按标题查，最后才创建。 */
  async function folder() {
    const cached = readJson(folderFile, null);
    if (cached?.id && cached.title === title) return cached;
    const jar = cookies();
    const mid = jar.DedeUserID;
    if (!mid) throw new Error('未登录：先配置 cookie');
    const list = await bili('/x/v3/fav/folder/created/list-all', { params: { up_mid: mid } });
    const found = (list.json?.data?.list || []).find((item) => item.title === title);
    if (found) {
      const record = { id: found.id, title: found.title };
      writeJson(folderFile, record);
      return record;
    }
    const created = await bili('/x/v3/fav/folder/add', {
      method: 'POST',
      body: new URLSearchParams({
        title,
        privacy: '1',
        csrf: jar.bili_jct || '',
      }).toString(),
    });
    if (created.json?.code !== 0) throw new Error(`创建收藏夹失败: ${created.json?.message}`);
    const record = { id: created.json.data.id, title };
    writeJson(folderFile, record);
    return record;
  }

  /** 把稿件加进收藏夹；B 站要的是 aid 不是 bvid。 */
  async function add(bvid) {
    const target = await folder();
    const info = await videoInfo(bvid);
    const jar = cookies();
    const result = await bili('/x/v3/fav/resource/deal', {
      method: 'POST',
      body: new URLSearchParams({
        rid: String(info.aid),
        type: '2',
        add_media_ids: String(target.id),
        del_media_ids: '',
        csrf: jar.bili_jct || '',
      }).toString(),
    });
    if (result.json?.code !== 0) throw new Error(`收藏失败: ${result.json?.message}`);
    return { folder: target.title, folderId: target.id };
  }

  /** 从收藏夹移除；用户把 like 改成别的反馈时调用。 */
  async function remove(bvid) {
    const target = await folder();
    const info = await videoInfo(bvid);
    const jar = cookies();
    const result = await bili('/x/v3/fav/resource/deal', {
      method: 'POST',
      body: new URLSearchParams({
        rid: String(info.aid),
        type: '2',
        add_media_ids: '',
        del_media_ids: String(target.id),
        csrf: jar.bili_jct || '',
      }).toString(),
    });
    if (result.json?.code !== 0) throw new Error(`取消收藏失败: ${result.json?.message}`);
    return { folder: target.title, folderId: target.id };
  }

  return { add, remove };
}
