import { createNeteaseProvider } from './netease/index.js';
import { ProviderRegistry } from './registry.js';

export { createNeteaseProvider, ProviderRegistry };

/** 全局 provider 注册表。默认以网易云为主 provider。 */
export const providers = new ProviderRegistry();
providers.register(createNeteaseProvider(), { primary: true });

/** @param {string} id */
export function getProvider(id) {
  return providers.get(id);
}

export function getDefaultProvider() {
  return providers.primary;
}
