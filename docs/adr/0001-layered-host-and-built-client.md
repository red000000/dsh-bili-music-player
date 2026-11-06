# ADR 0001：插件分层与 client 构建

**日期**：2026-11-06 ｜ **状态**：已采纳

## 背景

插件原先两个大文件：Host `src/plugin.js` 1171 行、Client `client.js` 856 行。工作区规范要求按「入口 / 领域 / 机制 / 装配」分层，并按抽象层级建目录。Client 侧还有一条额外约束：DSH 运行时以 lazy-CJS 加载预打包 bundle，`require()` 只解析平台模块、已物化记录、boot graph 行与已注册 factory，相对路径 import 会抛错。

## 决定

1. **Host 分层**：`src/adapters/` 接外部世界（B 站 HTTP、本地缓存、清单解析、状态文件），`src/domain/` 放规则（推荐、播放、反馈），`src/surface/` 放 DSH 接口面（HTTP 路由、工具），`src/plugin.js` 是唯一同时认识三层的组合根。
2. **依赖注入代替闭包**：领域模块通过参数拿依赖（store、state、searchMusic、relatedCandidates），不 import 适配器，保证依赖方向单向。
3. **Client 分目录 + 构建**：源码放 `client/`（`index.js` 注册、`bar.js` 组件、`diag.js`、`audio.js`），用 esbuild 打包成根目录 `client.js` 交付；构建产物提交进仓库，宿主只认这个文件。
4. **组件整体保留为一个模块**：`bar.js` 是单个 React 组件闭包，拆成多个文件只能靠 prop 透传，收益低于风险，因此暂不拆；超过 500 行的例外已在项目 AGENTS.md 记录。

## 后果

- 组合根 190 行，改播放规则不需要动路由，改路由不需要动规则。
- 领域逻辑可以脱网测试：`tests/recommendation.test.mjs` 用假 store 与假 state 覆盖画像合并、时长过滤、会话护栏。
- Client 交付物必须由 `npm run build` 生成；直接改 `client.js` 会在下一次构建被覆盖。
- 构建引入 esbuild（约 10 MB 平台二进制）。这与 `code.md` 「个人项目不引构建链」字面冲突，原因是 DSH 的 client 交付形态强制单文件；已向规范维护方提出口径确认（见 `tasks/2026-11-06-bili-music-restructure/notes/prompt-for-rules-owner.md`）。

## 备选

- **不分层，保持单文件**：改动成本最低，但违反目录分层要求，且领域规则无法脱网测试。
- **自研极简打包脚本**：免依赖，但要自己实现模块解析，属于重复造轮子。
- **不构建，client 保持手写单文件**：免构建链，但 client 无法分目录，与规范要求冲突。
