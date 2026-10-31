# 架构

MoodTune 是一个**零构建**的 Chrome Manifest V3 扩展：没有打包步骤，仓库根目录就是可加载的扩展目录，源码即产物。因此所有模块都使用浏览器原生 ESM，`import` 路径必须带扩展名。

## 分层

| 层 | 位置 | 职责 | 约束 |
| --- | --- | --- | --- |
| 扩展壳 | `manifest.json`、`background.js`、`offscreen.js`、`options.*`、`fs-manager.js`、`fs-sync.js` | 组合根、宿主 API、页面入口 | 只做装配与宿主适配，不写业务规则 |
| agent | `src/agent/` | 提示词、模型调用、检索计划、对话编排 | 不 import `chrome` |
| providers | `src/providers/` | 音乐平台适配 | 不 import `chrome`，也不 import agent |
| services | `src/app/services/` | 业务动作：结算、恢复、保存、播放控制 | 通过注入的 `send`/`player` 间接用宿主能力 |
| storage | `src/app/storage/` | 持久化与并发串行化 | `area` 注入，不直接读全局 `chrome` |
| background | `src/app/background/` | 消息路由、处理器、扩展事件、宿主适配器 | 不写业务规则 |
| audio | `src/app/audio/` | Web Audio 效果链（EQ + 宽度/串音/早期反射/混响/动态） | 只做节点与参数，不 import `chrome`，不做业务判断 |
| sidepanel | `src/app/sidepanel/` | DOM 渲染、交互、播放栏 | 不直接调用平台接口 |
| core | `src/core/` | 常量、EQ、效果链配置、音效预设、Track、JSON、队列等纯函数 | 不 import 任何上层 |

依赖方向（箭头表示「可以依赖」）：

```text
sidepanel ──chrome.runtime──▶ background/router ──▶ handlers
                                                      │
                                                      ├─▶ services ─▶ storage ─▶ chrome.storage.local
                                                      ├─▶ agent ─▶ llm(fetch) / recommendation ─▶ providers
                                                      └─▶ providers ─▶ 平台 HTTP
offscreen ◀── chrome.runtime.sendMessage ── background（PLAYER_* / EQ_* / EFFECTS_*）
offscreen ──▶ audio/graph（Web Audio 节点图）
```

## 四个运行时上下文

| 上下文 | 入口 | 职责 |
| --- | --- | --- |
| Service Worker | `background.js` | 装配依赖、路由消息、持有 storage/provider、管理 offscreen 生命周期 |
| Side Panel | `sidepanel.html` + `sidepanel.js` | 会话与卡片渲染、抽屉、输入栏、播放栏 |
| Offscreen | `offscreen.html` + `offscreen.js` | `<audio>` 播放、Web Audio 10 段 EQ + 效果链；**不直接访问网络与 storage** |
| Options | `options.html` + `options.js` | 大模型配置、文件夹绑定与同步操作 |

Offscreen 之所以被隔离，是因为 MV3 的 service worker 随时可能被回收，音频必须挂在独立文档上；而解析播放地址需要平台鉴权，所以统一回后台处理（`PLAYER_RESOLVE_URL`）。

## 关键流程

### 对话检索

```text
sidepanel            background                      agent                       provider
   │ chatStart ────────▶ chat handler
   │ ◀──── { ok: true }       │ chat.start()
   │                         │ ──▶ route()  ROUTER_SYSTEM 判定 mode
   │ ◀── THINKING_START ─────│
   │                         │ ──▶ search()
   │                         │      ├─ PLANNER_SYSTEM → normalizePlan()
   │                         │      ├─ executeQuery() ──────────────────────▶ searchTracks / …
   │                         │      ├─ dedupByWeight() + coarseFilter()
   │                         │      ├─ RERANK_SYSTEM → selectPicks()
   │ ◀── CHAT_PROGRESS ──────│
   │ ◀── THINKING_END ───────│
   │                         │ ──▶ sessions.appendMessage({ kind: 'plan-card' })
```

- `chatAgent.start()` **不阻塞响应**：处理器立刻回 `{ ok: true }`，进度通过 `CHAT_*` 事件推进。
- 中止由 agent 自己持有 `AbortController`，`start()` 会顶掉上一轮；中止后不再写错误卡片。
- 所有对侧边栏的事件统一走 `notify()`（即 `forwardToSidepanel`）。

### 播放与调音

```text
sidepanel ──PLAYER_TOGGLE/NEXT/…──▶ background ──▶ offscreen
offscreen ──PLAYER_RESOLVE_URL────▶ background ──▶ provider.resolveStreamUrl(song)
sidepanel ──setEqDirect───────────▶ background ──▶ offscreen（EQ_SET）
sidepanel ──setEffectsDirect──────▶ background ──▶ offscreen（EFFECTS_SET）
sidepanel ──applySoundPreset──────▶ background ──▶ EQ_SET + EFFECTS_SET（一次换一整套）
```

`PLAYER_*` 在路由里是**前缀兜底**：除了 `PLAYER_RESOLVE_URL`、`PLAYER_STATE_CHANGED` 需要特判，其余指令直接转发给 offscreen，新增播放指令不必改路由。

音频链在 [src/app/audio/graph.js](../src/app/audio/graph.js)：

```text
source → preamp → EQ(10 段 peaking) → 宽度 → 串音 → 早期反射 → 混响 → 动态 → 限幅 → destination
```

- **每个效果块都是干/湿并行的可旁路模块**，默认全关；全关时等价于只有 EQ，听感与旧版本一致（有测试兜底）。
- 参数归一化在 [src/core/effects.js](../src/core/effects.js)，图只管把参数落到节点上，并用 `setTargetAtTime` 平滑，避免切换预设爆音。
- 混响用**程序合成的 IR**（指数衰减噪声），不打包音频文件；IR 按参数缓存。
- 某个块在当前环境缺 API 时只跳过该块，不影响播放与 EQ。
- 末端限幅器是兜底，不面向用户配置：只要还有任何一个块在工作就接入（阈值 -1 dB、20:1），全旁路时一并退出。

「音效」是比 EQ 高一层的东西：一条音效 = `{ eq, effects }`。内置音效在 [src/core/sound-presets.js](../src/core/sound-presets.js)，用户保存的预设复用 `eqPresets` 表（可带 `effects`）。套用后用户仍然拖 EQ 滑杆，改的只是链里的 EQ 节点，所以「预设之上自由调整」不需要额外机制；UI 用状态指纹判断是否还等于预设，不等就显示「已调整」。

### 持久化

`chrome.storage.local` 的键集中在 [src/app/storage/keys.js](../src/app/storage/keys.js)：

| 键 | 内容 |
| --- | --- |
| `chatSessions` | 会话数组（含 messages / cart / result） |
| `currentSessionId` | 当前会话 id |
| `savedPlaylists` | 保存的播放列表 |
| `eqPresets` | EQ 预设 |
| `currentEq` / `currentEffects` / `playerVolume` | 播放器偏好 |
| `llmConfig` | 大模型配置（options 页写入） |

所有「读 → 改 → 写」都必须经过 [src/app/storage](../src/app/storage) 里的仓储，它们共享 [storage-queue.js](../src/app/storage/storage-queue.js) 的按键队列：同一个键串行、不同键并行。直接 `chrome.storage.local.set` 只允许出现在单键、无读改写的场景（偏好回写、文件夹恢复）。

`fs-sync.js` 把上面四个业务键镜像到用户选择的文件夹（`playlists.json`、`eq-presets.json`、`sessions/*.json`、`.meta.json`），恢复时同样走 storage 队列。

### 消息协议

- 请求两种形状：`{ action: 'listSessions' }` 或 `{ target: 'background', type: 'PLAYER_TOGGLE' }`
- 响应统一信封：成功 `{ ok: true, ... }`，失败 `{ ok: false, error }`（fs 系列历史原因用 `reason`）
- 事件：`{ target: 'sidepanel', type: 'CHAT_STREAM_CHUNK' | … }`

新增消息只需在 [handlers](../src/app/background/handlers) 里加一个方法并合并进路由，不要再写 if 分支。

## 不变量

这些约束都有测试兜底，改动时不要绕过：

| 不变量 | 守卫 |
| --- | --- |
| 零构建、原生 ESM | 无打包配置；`manifest.test.js` 校验入口存在且为 module |
| core 不依赖宿主 | `src/core/*` 只 import 同层与常量 |
| offscreen 不直连平台 | [tests/offscreen.test.js](../tests/offscreen.test.js) 禁止 `music.163.com` / 直接 `fetch` |
| 会话写入串行 | [tests/app/storage/sessions.test.js](../tests/app/storage/sessions.test.js) 并发用例 |
| 默认效果链必须完全旁路 | [tests/app/audio/graph.test.js](../tests/app/audio/graph.test.js) |
| 页面无内联脚本/样式 | [tests/pages.test.js](../tests/pages.test.js) |
| 版本号单一来源 | `manifest.json`；`fs-sync` 用 `chrome.runtime.getManifest().version` |
| 平台能力通过 provider 暴露 | [tests/providers](../tests/providers) |

## 测试

```text
tests/
├── core/           纯函数
├── providers/      平台契约、映射、HTTP、客户端、注册表
├── agent/          提示词、LLM 流式、检索计划、调音、对话编排
├── app/
│   ├── storage/    仓储与并发
│   ├── audio/      效果链节点与旁路行为（假 AudioContext）
│   ├── services/   业务服务
│   ├── background/ 路由、处理器、事件
│   └── sidepanel/  格式化与卡片渲染
├── helpers/        内存版 storage
├── manifest.test.js / pages.test.js / offscreen.test.js
└── background-provider-wiring.test.js   用 chrome 桩跑真实 background.js
```

`npm run check` = ESLint + 全量测试。新增模块时优先补「纯函数/服务层」测试，DOM 相关保持薄。

## 演进方向

- **多平台**：实现 `MusicProvider` 并注册（见 [PROVIDERS.md](PROVIDERS.md)），UI 与检索链路无需改动。
- **音效生态**：效果块已全部落地（含末端限幅兜底），内置音效覆盖基础音色与空间/动态两组；下一步是耳机频响适配（外部曲线库 + 参数 EQ）与让 Agent 直接推荐音效。
- **DSH 插件**：`src/core`、`src/providers`、`src/agent` 都不依赖 `chrome`，可直接被宿主复用；剩余工作是提供 `ctx.tools.register` 适配层与客户端插槽。
