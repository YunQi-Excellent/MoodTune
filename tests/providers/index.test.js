import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRegistry,
  getDefaultProvider,
  getProvider,
  providers,
} from '../../src/providers/index.js';

describe('默认 provider 注册表', () => {
  it('默认注册网易云并作为主 provider', () => {
    expect(providers.ids()).toEqual(['netease']);
    expect(getDefaultProvider()?.id).toBe('netease');
    expect(getProvider('netease')?.capabilities.effects).toBe(true);
    expect(getProvider('missing')).toBeNull();
  });

  it('createProviderRegistry 可注入外部播放器', async () => {
    const pause = vi.fn(async () => {});
    const registry = createProviderRegistry({ externalPlayer: { pause } });

    await registry.primary.pauseExternalPlayback();

    expect(pause).toHaveBeenCalledTimes(1);
  });
});
