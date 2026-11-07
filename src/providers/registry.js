import { AUTH_KINDS, PLAYBACK_MODES, SEARCH_KINDS } from './types.js';

const REQUIRED_METHODS = [
  'searchTracks',
  'searchPlaylists',
  'getPlaylistTracks',
  'getUserPlaylists',
  'getArtistTracks',
  'resolveStreamUrl',
];

/**
 * 校验 provider 是否满足契约。注册时调用，避免半成品适配器进入运行时。
 * @param {import('./types.js').MusicProvider} provider
 * @returns {import('./types.js').MusicProvider}
 */
export function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('provider 必须是对象');
  }
  if (typeof provider.id !== 'string' || provider.id.trim() === '') {
    throw new Error('provider.id 必须是非空字符串');
  }
  if (typeof provider.label !== 'string' || provider.label.trim() === '') {
    throw new Error(`provider(${provider.id}).label 必须是非空字符串`);
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`provider(${provider.id}) 缺少方法：${method}`);
    }
  }

  const capabilities = provider.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    throw new Error(`provider(${provider.id}).capabilities 缺失`);
  }
  if (!PLAYBACK_MODES.includes(capabilities.playback)) {
    throw new Error(`provider(${provider.id}) playback 非法：${capabilities.playback}`);
  }
  if (!AUTH_KINDS.includes(capabilities.auth)) {
    throw new Error(`provider(${provider.id}) auth 非法：${capabilities.auth}`);
  }
  if (!Array.isArray(capabilities.search)
    || capabilities.search.some(kind => !SEARCH_KINDS.includes(kind))) {
    throw new Error(`provider(${provider.id}) search 能力非法`);
  }
  if (typeof capabilities.effects !== 'boolean') {
    throw new Error(`provider(${provider.id}) effects 必须是布尔值`);
  }

  return provider;
}

export class ProviderRegistry {
  #providers = new Map();
  #primaryId = null;

  constructor(providers = []) {
    for (const provider of providers) this.register(provider);
  }

  /**
   * @param {import('./types.js').MusicProvider} provider
   * @param {{primary?: boolean}} [options]
   * @returns {ProviderRegistry}
   */
  register(provider, { primary = false } = {}) {
    assertProvider(provider);
    if (this.#providers.has(provider.id)) {
      throw new Error(`provider 已注册：${provider.id}`);
    }

    this.#providers.set(provider.id, provider);
    if (primary || this.#primaryId === null) this.#primaryId = provider.id;
    return this;
  }

  /** @param {string} id */
  get(id) {
    return this.#providers.get(id) ?? null;
  }

  /** @param {string} id */
  require(id) {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`未注册的 provider：${id}`);
    return provider;
  }

  /** @param {string} id */
  has(id) {
    return this.#providers.has(id);
  }

  list() {
    return [...this.#providers.values()];
  }

  ids() {
    return [...this.#providers.keys()];
  }

  get primary() {
    return this.#primaryId ? this.require(this.#primaryId) : null;
  }

  get primaryId() {
    return this.#primaryId;
  }

  /** @param {string} id */
  setPrimary(id) {
    this.require(id);
    this.#primaryId = id;
    return this;
  }
}
