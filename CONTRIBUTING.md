# 贡献指南

感谢你愿意改进 MoodTune。这个项目刻意保持「零构建」，所以改动门槛很低，但也需要遵守几条约束。

## 环境要求

- Node.js **>= 20.19**（仅用于 lint / test，不影响扩展运行）
- Chrome **>= 116**（`chrome.runtime.getContexts` 的最低版本）
- 无需打包工具、无需 TypeScript 编译

## 快速开始

```bash
git clone git@github.com:YunQi-Excellent/MoodTune.git
cd MoodTune
npm install

npm run check   # ESLint + 全量测试
```

加载扩展：

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择仓库根目录
4. 点扩展图标打开侧边栏；首次使用先到「设置」配置大模型 Endpoint / Model / API Key

改动源码后，在 `chrome://extensions` 点一次刷新即可生效；改 CSS 或 HTML 同样不需要构建。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | lint + 测试，提交前必须通过 |
| `npm test` | 只跑 Vitest |
| `npm run test:watch` | 监听模式 |
| `npm run lint` / `npm run lint:fix` | ESLint |

如果 npm 因缓存目录权限安装失败，可指定缓存位置：

```bash
npm --cache /tmp/npm-cache install
```

## 项目约束

1. **零构建**：不引入打包器、转译器、CSS 预处理器。浏览器必须能直接跑源码。
2. **原生 ESM**：`import` 必须带 `.js` 扩展名；页面脚本用 `<script type="module">`。
3. **分层依赖**：`src/core` 不依赖上层；`providers` / `services` / `storage` / `agent` 不直接 import `chrome`。需要宿主能力时通过参数注入（参考 `createPlayerService({ send })`）。
4. **storage 写入走仓储**：会话、歌单、预设的读改写统一经 [src/app/storage](src/app/storage)，不要直接 `chrome.storage.local.set`，否则并发会丢写。
5. **平台能力走 provider**：不要在 UI 或 agent 里判断「是不是网易云」，用 `capabilities` 或 `provider.id`。
6. **消息走路由**：新增 action 在 [handlers](src/app/background/handlers) 里加方法，由 `createMessageRouter` 合并，不要往 `background.js` 里加 if。
7. **用户可见文案用中文**，错误信息保持简短、可行动（会直接进错误卡片）。
8. **注释解释「为什么」**，不写「做什么」的流水账。

## 目录速查

| 想改什么 | 去哪 |
| --- | --- |
| 提示词 / 模型调用 | `src/agent/prompts.js`、`src/agent/llm.js` |
| 检索计划、去重、粗筛 | `src/agent/recommendation.js` |
| 对话流程 | `src/agent/chat.js` |
| 新增平台 | `src/providers/<platform>/`（见 [docs/PROVIDERS.md](docs/PROVIDERS.md)） |
| 新消息接口 | `src/app/background/handlers/` |
| 会话 / 购物车 / 结算 | `src/app/services/sessions.js` |
| 保存的播放列表 / EQ 预设 | `src/app/services/assets.js` |
| 效果链节点与参数 | `src/app/audio/graph.js`、`src/core/effects.js` |
| 内置音效预设 | `src/core/sound-presets.js` |
| 播放控制 / 平台解析 | `src/app/services/player.js` |
| 侧边栏 UI | `sidepanel.js`、`src/app/sidepanel/`、`sidepanel.css` |
| 设置页 | `options.js`、`options.css` |
| 文件夹同步 | `fs-sync.js`、`fs-manager.js` |

## 测试

- 结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#测试)
- 纯逻辑（core / recommendation / format / cards）优先直接断言输入输出
- 涉及 `chrome` 的行为用桩：见 [tests/background-provider-wiring.test.js](tests/background-provider-wiring.test.js)
- 并发相关改动必须补「延迟注入」用例（`createMemoryArea({ delay: 1 })`）
- 静态不变量有专门守卫（offscreen、页面、manifest），改动时不要删

## 提交信息

使用 `类型: 一句话` 的形式，类型沿用现有历史：

```text
feat: 新增 provider 注册表
refactor: 拆分消息路由与处理器
fix: 修复并发追加消息丢写
chore: 搭建工程基线
docs: 补充架构文档
test: 补充检索计划测试
```

一次提交只做一件事；重构与功能不要混在一起。

## 手动冒烟清单

自动化测试覆盖不到真实网易云接口与音频，发版前请手动过一遍：

- [ ] 对话搜索：正常检索、进度条、结果卡片、「加入歌单」
- [ ] 检索中止：点停止后立即停下且不出现错误卡片
- [ ] 调音：一句话调 EQ → 卡片滑杆可拖动 → 应用生效
- [ ] 保存：保存歌单 / 保存调音，在「我的内容」里能看到
- [ ] 播放：播放 / 暂停 / 上一首 / 下一首 / 拖动进度 / 音量
- [ ] 关闭侧边栏后音乐继续播放，重开侧边栏状态恢复
- [ ] 网页版网易云正在播放时，插件播放会自动暂停页面音频
- [ ] EQ 十段与预设应用、重置
- [ ] 音效：我的内容 → 音效，逐个切换能听出差别；切完再拖 EQ 滑杆，提示从「使用中」变成「已调整」
- [ ] 调音卡片顶部的音效 chips：点一下滑杆整体跳到那套值，chips 高亮跟着变
- [ ] 会话：新建 / 切换 / 重命名 / 删除 / 恢复
- [ ] 设置页：配置大模型、绑定文件夹、立即同步、从文件恢复

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：分层、运行时、数据流、不变量
- [docs/PROVIDERS.md](docs/PROVIDERS.md)：平台契约与新增平台步骤
- [docs/README.md](docs/README.md)：功能介绍与安装
