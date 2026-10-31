# 平台适配（Providers）

MoodTune 把「音乐从哪来」抽象成 `MusicProvider`。检索链路、对话 agent、播放链路都只依赖这份契约，因此新增平台不需要改 UI 或流程代码。

## 契约

实现位于 [src/providers](../src/providers)，契约类型见 [types.js](../src/providers/types.js)。

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `searchTracks` | `{ keyword, limit?, offset?, order? }` | `{ tracks: Track[], total, via? }` |
| `searchPlaylists` | `{ keyword, limit? }` | `PlaylistSummary[]` |
| `getPlaylistTracks` | `(playlistId, { maxTracks? })` | `Track[]` |
| `getUserPlaylists` | `{ limit?, offset? }` | `{ user: { uid, nickname }, playlists: PlaylistSummary[] }` |
| `getArtistTracks` | `(artistName)` | `{ artist, tracks, albumsFound, failedAlbums, successPaths }` |
| `resolveStreamUrl` | `(track)` | `string`（可直接喂给 `<audio>` 的地址） |
| `pauseExternalPlayback` | —— | `Promise<void>`（可选） |

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

`createProviderRegistry()` 默认只注册网易云。后台在 `background.js` 里注入外部播放器适配器后使用。

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
