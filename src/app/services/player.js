import { PLAYER_DEFAULTS } from '../../core/constants.js';

/**
 * 播放器服务：把「跟播放器对话」收敛成一个对象。
 *
 * - 前半部分是 offscreen 播放器的语义化方法（设置歌单 / 调音 / 状态）
 * - resolveStreamUrl 负责按歌曲的 provider 找到对应平台解析地址
 * - pauseExternal / loadPrefs / saveEq 负责跨平台暂停与偏好持久化
 *
 * 依赖全部注入：`send` 是往 offscreen 发消息，`providers` 是平台注册表，
 * `prefs` 是偏好仓储。这样服务本身不依赖 chrome.*，可以直接单测。
 *
 * @param {object} options
 * @param {(type: string, payload?: object) => Promise<any>} options.send
 * @param {{ primary: object, get: (id: string) => object }} options.providers
 * @param {{ saveEq: Function, saveVolume: Function, load: Function }} options.prefs
 * @param {{ volume: number }} [options.defaults]
 */
export function createPlayerService({ send, providers, prefs, defaults = PLAYER_DEFAULTS } = {}) {
  if (typeof send !== 'function') throw new Error('createPlayerService 需要 send');
  if (!providers) throw new Error('createPlayerService 需要 providers');

  const call = (type, payload = {}) => send(type, payload);

  return {
    /* ---- 播放控制 ---- */
    getState: () => call('PLAYER_GET_STATE'),
    setPlaylist: (songs, autoPlay = true) => call('PLAYER_SET_PLAYLIST', { songs, autoPlay }),

    /* ---- EQ ---- */
    getEq: () => call('EQ_GET'),
    setEq: eq => call('EQ_SET', { eq }),
    resetEq: () => call('EQ_RESET'),

    /* ---- 效果链（宽度/串音/早期反射/混响/动态） ---- */
    getEffects: () => call('EFFECTS_GET'),
    setEffects: effects => call('EFFECTS_SET', { effects }),
    resetEffects: () => call('EFFECTS_RESET'),

    /** 直接转发给 offscreen（PLAYER_* 通配入口）。 */
    dispatch: (type, payload) => call(type, payload),

    /* ---- 音乐平台 ---- */
    async resolveStreamUrl(song) {
      if (!song) throw new Error('缺少歌曲信息');
      const provider = song.provider ? providers.get(song.provider) : providers.primary;
      if (!provider) throw new Error(`未注册的音乐平台：${song.provider || 'unknown'}`);
      return provider.resolveStreamUrl(song);
    },

    async pauseExternal() {
      try {
        await providers.primary?.pauseExternalPlayback();
      } catch {}
    },

    /* ---- 偏好 ---- */
    saveEq(eq) {
      prefs?.saveEq(eq);
    },

    saveEffects(effects) {
      prefs?.saveEffects(effects);
    },

    saveVolume(volume) {
      prefs?.saveVolume(volume);
    },

    async loadPrefs() {
      const saved = prefs ? await prefs.load() : null;
      return {
        ok: true,
        volume: typeof saved?.volume === 'number' ? saved.volume : defaults.volume,
        eq: saved?.eq || null,
        effects: saved?.effects || null,
      };
    },
  };
}
