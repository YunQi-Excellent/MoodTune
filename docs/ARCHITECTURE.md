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
   │                         │ ──▶ extractUserQuery()  EXTRACT_SYSTEM（并行）
   │                         │ ──▶ decide()  DECIDE_SYSTEM（意图 + 检索计划，一次调用）
   │                         │      ├─ 原文直搜命中？──▶ searchTracks（相关性排序）
   │                         │      │    └─ 命中 → 直接出 plan-card（跳过决策/挖歌单/精排）
   │                         │      └─ 未命中 → 用 decide 带回的 queries 继续
   │                         │ ──▶ search()
   │                         │      ├─ runQueries()  并发 executeQuery() ──▶ searchTracks / …
   │                         │      ├─ dedupByWeight() + coarseFilter()
   │                         │      ├─ 剩余预算 ≥ 6s 才跑 RERANK_SYSTEM → selectPicks()
   │ ◀── CHAT_PROGRESS ──────│
   │ ◀── THINKING_END ───────│
   │                         │ ──▶ sessions.appendMessage({ kind: 'plan-card' })
```

- **意图判定和检索规划合并成一次调用**（[DECIDE_SYSTEM](../src/agent/prompts.js)）：原来的 `route()` + `PLANNER_SYSTEM` 是两次模型往返，氛围类需求光这一步就要 5~10s。合并后只调一次，且提示词要求**纯 JSON、不写分析文字**，输出 token 大幅减少。解析失败/超时进兜底计划（见下一条），不写错误卡片。
- **兜底计划绝不拿整句去搜**：决策没给出 `queries` 时，用「抽取阶段拿到的检索词 → 削掉口语前缀的原话 → 剥掉 `op/ed` 的核心词」依次补最多 3 条关键词。整句直搜在平台上会被切成「我想」这类高频词——`我想听高达SEED中的op` 会返回一屏《我想牵着你的手》，看起来像正常结果，实际全是噪声。这类兜底计划带 `fallback: true`，卡片上标「关键词兜底」，思考记录里写明退回了哪些检索词。
- **原文直搜是最短路径**：抽取提示词只做「把用户原话里要点名检索的片段原样截出来」，不负责改写。命中判定见 [literal.js](../src/agent/literal.js)：检索核心词落在歌名/专辑/歌手里即视为命中（`酒神op` → 《霓虹下的酒神》）。命中后不再决策、不挖歌单、不精排，直接出结果。
  - 第一枪打原话；没命中再用剥掉 `op/ed/ost/主题曲` 与连接词的核心词搜一次（`P4D的op` → `p4d`）。平台会把「的」「op」当独立词，直接用原话搜只会返回一堆钢琴练习曲。
  - 直搜命中时立刻中止那次决策调用，不再等它，也不让它的文字继续往思考节点里灌。
- **「再找一些」是追加，换了主题就是重来**：结果卡会记下这一轮的主体（`plan.need` / `plan.topic`）。下一轮先问一句「还是同一件事吗」——`resolveCarry()` 用用户这句话里的主体去比上一轮主题，`换一批/不对` 直接判新需求，主题对不上就丢弃上一轮结果。模型给的 `carryOver` 只是候选答案：它一看到【上一轮】上下文就容易判成 true，`我想听p4d的op` 曾经因此把上一轮 SEED 的候选一起拼回卡里。判定为追加时，才取最后一张卡的候选（已进歌单的不算）并加进新检索的排除集，最后把「上轮保留 + 本轮新增」合成一张卡（总量封顶 20）。一条都没新增时只回一条文字提示，不重复渲染整张卡片。直搜结果如果和上一轮完全重合，也不会短路，而是等决策走追加。
- **检索动作并发执行**（默认 3 路）：`runQueries()` 用工作池跑 `plan.queries`，任何一路失败只丢这一路。串行执行时 5 条 query × 挖歌单会把预算吃干。
- **挖歌单有硬上限**：单条 `searchPlaylists` / `myPlaylists` 最多挖 4 个歌单、每个 150 首（[INTENT_CONFIG](../src/core/constants.js)），规划出的 `limit: 20 / 500` 会被强制收窄。
- **一次检索有硬预算**（默认 60s，从用户按下发送开始算）：决策、抽取、执行、精排共享同一个截止时间；决策单独封顶 25s 且不超过剩余预算（推理型模型 15s 时常常还在思考，掐掉就只能走关键词兜底），**剩下的约 35s 全部留给执行 + 精排**。超时就中止并说明**卡在哪个阶段**（「模型决策阶段就用完预算」≠「检索超时」）。
- **预算到点不丢已拿到的结果**：`runQueries()` 在被切断时把已经跑完的检索动作交回来（`aborted: true`），检索阶段超时仍有候选就照常出卡（标「未精排」），只有一首都没拿到才报超时。决策吃掉大半预算时，这一条决定用户是拿到半份结果还是拿到一张错误卡。
- **精排要留够时间**：执行完如果剩余预算不足 6s，直接按已召回候选出结果（`stats.rerankSkipped`），不硬跑一次必超时的精排。
- **阶段耗时会写进结果**：`thinking.timings` 记录 `decide / execute / rerank` 各自用时，随思考记录一起展示，错误卡片上也会直接显示，方便判断是模型慢还是检索慢。
- **结果卡可以直接全选/清空**：卡片统计行右侧的按钮只切换勾选状态（不发请求），确认后再点「加入歌单」。
- **结果卡写明这轮到底搜了什么**：统计行给「候选 / 粗筛 / 未精排 / 关键词兜底」，下面一行直接列出本轮用到的检索词（悬停看全）。结果不对时能一眼分清是「搜错了词」还是「搜到了但排错了序」。精排一首都没留下时回一条文字说明，而不是一张 0 首的空卡片。
- **思考记录会持久化**：流式文本（含推理模型的 `reasoning_content`）另行收集一份，随 `plan-card` / `eq-card` / `error` 的 `thinking` 字段落库（头 1200 + 尾 2800 字）；模型什么都没吐时用阶段耗时兜底，卡片永远不会是一条点不开的空记录。重载侧边栏后在卡片里展开即可回看，不依赖实时 DOM。
- `chatAgent.start()` **不阻塞响应**：处理器立刻回 `{ ok: true }`，进度通过 `CHAT_*` 事件推进。
- 一次检索只在真正结束时发一次 `CHAT_THINKING_END`；中间的 `execute / rerank` 用 `CHAT_THINKING_START` 切换阶段。提前发结束事件会让侧边栏收起中断按钮，用户在长时间挖歌时就没法停止了。
- 中止由 agent 自己持有 `AbortController`，`start()` 会顶掉上一轮；中止后不再写错误卡片。`signal` 会一路传给 `executeQuery → provider → HTTP`，正在跑的检索和分批拉取会立刻取消，而不是等它自己跑完。
- 所有对侧边栏的事件统一走 `notify()`（即 `forwardToSidepanel`）。

### 播放与调音

```text
sidepanel ──PLAYER_TOGGLE/NEXT/…──▶ background ──▶ offscreen
offscreen ──PLAYER_RESOLVE_URL────▶ background ──▶ provider.resolvePlayback(song)
                                                     ├─ 远程：{ kind:'url', url }
                                                     └─ 本地：{ kind:'local', path }
sidepanel ──setEqDirect───────────▶ background ──▶ offscreen（EQ_SET）
sidepanel ──setEffectsDirect──────▶ background ──▶ offscreen（EFFECTS_SET）
sidepanel ──applySoundPreset──────▶ background ──▶ EQ_SET + EFFECTS_SET（一次换一整套）
```

`PLAYER_*` 在路由里是**前缀兜底**：除了 `PLAYER_RESOLVE_URL`、`PLAYER_STATE_CHANGED` 需要特判，其余指令直接转发给 offscreen，新增播放指令不必改路由。

播放模式（顺序 / 单曲循环 / 随机）的「下一首是谁」由 [src/core/playback.js](../src/core/playback.js) 的 `createPlaybackNavigator` 决定，offscreen 只负责把 `PLAY | REPEAT | RESTART | STOP` 映射成音频动作：

- **顺序播放**：从头走到尾，队尾停止；手动上一首/下一首也不会绕回。
- **单曲循环**：只接管自然播完（重播当前歌）；手动下一首仍能离开当前歌。
- **随机播放**：一轮内是完整排列、不重复；一轮结束后重新洗牌，并避免新的一轮立刻重复刚播完的歌。
- 切到随机模式时保留当前歌，只洗剩下的；从歌单直接点播也会同步随机游标。
- 模式通过 `PERSIST_PLAYBACK_MODE` 回写 `playerPlaybackMode`，offscreen 启动时随音量/EQ 一起恢复。
- 每次换歌都会生成自增 `loadToken`：解析地址可能乱序返回，过期请求直接丢弃，避免「第二次点击被第一次的迟到结果覆盖」。单击上一首直接切歌，不做「播放超过 3 秒先回本曲开头」的二次确认。

本地音乐走同一条播放链路，但播放源是文件而不是 HTTP：

- 侧边栏用 `showDirectoryPicker({ mode:'read' })` 选目录，`FileSystemDirectoryHandle` 存 IndexedDB（键 `musicLibrary`），索引存 `localMusicLibrary`。
- 扫描在 background 完成（[scanner.js](../src/providers/local/scanner.js)），只收录浏览器能直接播放的扩展名；标签读取失败时用文件名兜底。
- [local provider](../src/providers/local/index.js) 的 `resolvePlayback()` 返回 `{ kind:'local', path }`；offscreen 读取同一个目录句柄，生成 `blob:` URL 后交给 `<audio>`，换歌时 revoke 上一个 URL。
- 本地音频同样经过 Web Audio 音频链，EQ/音效不需要平台支持。

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

会话正文已经从 `chrome.storage.local` 的单 key 数组迁移到 **IndexedDB 日志型存储**，定义在 [src/app/storage/session-log.js](../src/app/storage/session-log.js)。旧键仍会保留一个版本作为迁移回滚备份，但运行时不再读写。

| 存储 | 键 / store | 内容 |
| --- | --- | --- |
| IndexedDB | `meta` | `schemaVersion`、`currentSessionId`、迁移时间 |
| IndexedDB | `sessions` | 会话元数据（名称、时间、`lastSeq`、各类计数） |
| IndexedDB | `messages` | 按 `[sessionId, seq]` 追加的消息记录 |
| IndexedDB | `states` | 购物车、`cartEq`、结算结果等可变投影 |
| chrome.storage.local | `chatSessions` | v1 旧数组，仅首次迁移读取，成功后保留备份 |
| chrome.storage.local | `currentSessionId` | v1 旧当前会话，仅迁移读取 |
| chrome.storage.local | `savedPlaylists` | 保存的播放列表 |
| chrome.storage.local | `eqPresets` | EQ 预设 |
| chrome.storage.local | `currentEq` / `currentEffects` / `playerVolume` / `playerPlaybackMode` | 播放器偏好 |
| chrome.storage.local | `localMusicLibrary` | 本地音乐索引（路径、标签、时长）；不含音频文件本身 |
| chrome.storage.local | `llmConfig` | 大模型配置（options 页写入） |

会话写入规则：

- `appendMessage` 只写一条 `messages` 记录并更新 `sessions` 的计数/`lastSeq`，不再整表重写。
- `cart` / `result` / `cartEq` 写入 `states`，不会触碰消息记录。
- 列表接口只读 `sessions` 元数据；打开会话读取最后一页消息，向上滚动时按 `[sessionId, seq]` 游标继续加载。
- 迁移在第一次打开数据库时自动执行：读取旧 `chatSessions`，按数组顺序为消息分配 `seq`，写入后设置 `schemaVersion = 2`；重复执行是幂等的。

`chrome.storage.local` 的其余业务键仍共享 [storage-queue.js](../src/app/storage/storage-queue.js) 的按键队列：同一个键串行、不同键并行。直接 `chrome.storage.local.set` 只允许出现在单键、无读改写的场景（偏好回写、文件夹恢复）。

`fs-sync.js` 通过 `setSessionBridge()` 接会话仓储，把数据镜像到用户选择的文件夹（`playlists.json`、`eq-presets.json`、`sessions/*.json`、`.meta.json`）；恢复时调用仓储的 `replaceAll`，不再写回旧 `chatSessions`。本地音乐索引与目录句柄不参与镜像（路径只对本机有效）。

### 消息协议

- 请求两种形状：`{ action: 'listSessions' }` 或 `{ target: 'background', type: 'PLAYER_TOGGLE' }`
- 响应统一信封：成功 `{ ok: true, ... }`，失败 `{ ok: false, error }`（fs 系列历史原因用 `reason`）
- 事件：`{ target: 'sidepanel', type: 'CHAT_STREAM_CHUNK' | 'SESSION_CHANGED' | … }`
- 会话分页：`getCurrentSession` / `switchSession` 返回最后一页；`loadEarlierMessages` 按 `beforeSeq` 向前翻页。

新增消息只需在 [handlers](../src/app/background/handlers) 里加一个方法并合并进路由，不要再写 if 分支。

## 不变量

这些约束都有测试兜底，改动时不要绕过（`tests/` 只保留在本地开发环境，不纳入版本库，下表路径指本地目录）：

| 不变量 | 守卫 |
| --- | --- |
| 零构建、原生 ESM | 无打包配置；`manifest.test.js` 校验入口存在且为 module |
| core 不依赖宿主 | `src/core/*` 只 import 同层与常量 |
| offscreen 不直连平台 | [tests/offscreen.test.js](../tests/offscreen.test.js) 禁止 `music.163.com` / 直接 `fetch` |
| 会话追加不丢写 | [tests/app/storage/session-log.test.js](../tests/app/storage/session-log.test.js) 并发/分页用例 |
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
