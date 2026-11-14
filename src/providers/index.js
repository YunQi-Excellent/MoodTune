import { createLocalProvider } from './local/index.js';
import { createNeteaseProvider } from './netease/index.js';
import { ProviderRegistry } from './registry.js';

export { createLocalProvider, createNeteaseProvider, ProviderRegistry };

/**
 * 创建一组内置 provider。externalPlayer 由宿主注入，provider 本身不依赖 chrome.*。
 * @param {{externalPlayer?: {pause?: () => Promise<void>}}} [options]
 * @returns {ProviderRegistry}
 */
export function createProviderRegistry({ externalPlayer } = {}) {
  const registry = new ProviderRegistry();
  registry.register(createNeteaseProvider({ externalPlayer }), { primary: true });
  return registry;
}

/** 默认 provider 注册表（无外部播放器），供测试和宿主无关场景使用。 */
export const providers = createProviderRegistry();

/** @param {string} id */
export function getProvider(id) {
  return providers.get(id);
}

export function getDefaultProvider() {
  return providers.primary;
}
