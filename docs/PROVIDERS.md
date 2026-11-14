# 平台适配（Providers）

MoodTune 把「音乐从哪来」抽象成 `MusicProvider`。检索链路、对话 agent、播放链路都只依赖这份契约，因此新增平台不需要改 UI 或流程代码。

## 契约

实现位于 [src/providers](../src/providers)，契约类型见 [types.js](../src/providers/types.js)。

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `searchTracks` | `{ keyword, limit?, offset?, order?, signal? }` | `{ tracks: Track[], total, via? }` |
| `searchPlaylists` | `{ keyword, limit?, signal? }` | `PlaylistSummary[]` |
| `getPlaylistTracks` | `(playlistId, { maxTracks?, signal? })` | `Track[]` |
| `getUserPlaylists` | `{ limit?, offset?, signal? }` | `{ user: { uid, nickname }, playlists: PlaylistSummary[] }` |
| `getArtistTracks` | `(artistName, { signal? })` | `{ artist, tracks, albumsFound, failedAlbums, successPaths }` |
| `resolveStreamUrl` | `(track)` | `string`（可直接喂给 `<audio>` 的地址） |
| `resolvePlayback` | `(track)` | `{ kind: 'url' \| 'local' \| 'external', url?, path? }`（可选，优先于 `resolveStreamUrl`） |
| `pauseExternalPlayback` | —— | `Promise<void>`（可选） |

`signal` 是用户点「中断」时传下来的 `AbortSignal`。实现必须把它透传给 HTTP 请求，并在分批/分页循环里检查；中止时抛 `name === 'AbortError'` 的错误，**不要**被自己的兜底 catch 当成普通失败吞掉（用 `src/core/abort.js` 的 `isAbortError` / `throwIfAborted`）。

另外两个字段：

- `id`：稳定标识，会写进 `Track.provider`
- `label`：展示名，会出现在规划提示词里

注册时 [registry.js](../src/providers/registry.js) 会校验必需方法、`capabilities` 枚举与类型，半成品适配器进不了运行时。

## capabilities

```js
{
  playback: 'direct' | 'sdk' | 'external' | 'none',
  search: ['tracks', 'playlists', 'artists', 'userPlaylists'],
  auth: 'cookie' | 'oauth' | 'qr' | 'none',
  effects: true,
}
```

- `playback`：`direct` 表示能拿到直链交给 offscreen；`external` 表示只能控制页面里的播放器；`none` 表示只能给链接
- `search`：平台支持的检索种类。规划提示词会用 `label` + `search` 生成上下文，模型据此选择工具
- `auth`：鉴权方式，`cookie` 表示复用浏览器已登录状态
- `effects`：`false` 时前端应隐藏 EQ（目前默认平台为 `true`）

## Track

跨平台模型在 [src/core/track.js](../src/core/track.js)：

```js
{
  // 兼容旧字段
  id, name, artists, album, durationMs, cover, link,
  // 跨平台字段
  provider, providerId, key, artistList,
}
```

`trackKey(track)` 是去重的唯一依据（`provider:providerId`，缺省回退 `id`）。适配器必须保证同一首歌在不同检索路径下 `key` 稳定，否则候选会重复。

## 注册

```js
import { createProviderRegistry } from './src/providers/index.js';

const registry = createProviderRegistry({ externalPlayer });
registry.primary;        // 主平台（用于没有 provider 字段的旧数据）
registry.get('netease'); // 按 id 取
```

`createProviderRegistry()` 默认只注册网易云。后台在 `background.js` 里注入外部播放器适配器后使用，并额外注册本地音乐 provider；`primary` 仍是网易云，本地播放靠 `track.provider === 'local'` 路由。

## 新增一个平台

1. 建目录 `src/providers/<platform>/`，至少包含 `index.js`（导出 `createXxxProvider`）。
2. 实现上表方法，`capabilities` 按真实能力填写。
3. 在 [src/providers/index.js](../src/providers/index.js) 的 `createProviderRegistry` 里注册（或用 `registry.register(provider)`）。
4. 若平台不支持直链，`resolveStreamUrl` 返回外链地址，并把 `playback` 标为 `external`；播放器侧会走兜底逻辑。
5. 补测试：`tests/providers/<platform>-*.test.js`，请求层用 fixture 假数据，不打真实接口。

最小骨架：

```js
export function createXxxProvider({ fetchImpl } = {}) {
  const http = createHttpClient({ fetchImpl, baseUrl: 'https://api.example.com' });

  return {
    id: 'xxx',
    label: '示例平台',
    capabilities: {
      playback: 'direct',
      search: ['tracks', 'playlists'],
      auth: 'cookie',
      effects: true,
    },
    async searchTracks({ keyword, limit = 30, offset = 0 }) {
      const data = await http.requestJson('/search', { params: { q: keyword, limit, offset } });
      return { tracks: data.items.map(mapTrack), total: data.total };
    },
    // …其余必需方法
  };
}
```

## 本地音乐实现

目录：[src/providers/local](../src/providers/local)

本地目录不是远程平台：文件不复制、不上传，provider 只查扫描后的索引。

| 文件 | 职责 |
| --- | --- |
| `constants.js` | provider id、目录句柄键、支持的扩展名与扫描上限 |
| `metadata.js` | 轻量读取 ID3v1/ID3v2 与 FLAC Vorbis Comment；失败时返回空对象 |
| `scanner.js` | 递归扫描目录，按标签/文件名生成 `Track`，坏文件跳过 |
| `index.js` | 搜索、文件夹歌单、歌手聚合、`resolvePlayback` |

关键点：

- **目录句柄**存在 IndexedDB（`fs-manager.js`，键 `musicLibrary`），索引存在 `chrome.storage.local` 的 `localMusicLibrary`。
- **不复制音频**。`resolvePlayback()` 返回 `{ kind: 'local', path }`，offscreen 从同一个目录句柄读取 `File`，生成 `blob:` URL 交给 `<audio>`。
- **权限**：浏览器重启后目录权限可能变成 `prompt`，侧边栏的「重新授权」按钮会调用 `handle.requestPermission({ mode: 'read' })`。
- **扫描限制**：默认最多 10000 首、目录深度 12；超过上限返回 `truncated`，不会无限占内存。
- **标签**：支持 MP3 的 ID3v1/ID3v2 文本帧与 FLAC Vorbis Comment；其他格式先用文件名 `歌手 - 歌名` 兜底。

## 网易云实现

目录：[src/providers/netease](../src/providers/netease)

| 文件 | 职责 |
| --- | --- |
| `http.js` | `fetch` 封装：baseURL、`credentials: 'include'`、`code !== 200` 抛错、错误带 `cause` |
| `mapper.js` | 原始字段 → `Track` / `PlaylistSummary` / `ArtistSummary` |
| `auth.js` | 当前登录用户、用户歌单 |
| `client.js` | 检索、歌单分批、歌手专辑、音质降级 |
| `index.js` | 组装成 `MusicProvider` |
| `constants.js` | id、label、接口地址、默认值 |

几个值得知道的行为：

- **搜索兜底**：`cloudsearch` 失败或返回空时回落到老的 `search/get`
- **歌单分批**：网易云单次返回有上限，客户端按 offset 分批拉取直到 `maxTracks`
- **歌手全量**：先搜歌手，再逐专辑取歌；单专辑失败只记录到 `failedAlbums`
- **播放地址三级降级**：高音质 → 标准 → 低音质，任一返回 url 即止；地址统一升级为 `https`
- **外部播放器**：`pauseExternalPlayback` 由宿主适配器实现（见 [netease-external-player.js](../src/app/background/netease-external-player.js)），provider 本身不碰 `chrome.tabs`
- **鉴权**：依赖浏览器已登录的 cookie（`credentials: 'include'`），不保存任何凭据

## 兼容性

旧的对外 action（`fetchPlaylists`、`searchSongs`、`deepSearch`、`artistAllSongs`）仍然保留，但它们现在返回**归一化后的 `Track`**，不再是平台的原始字段。新代码请直接走 provider。
