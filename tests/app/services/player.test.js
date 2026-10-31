import { describe, expect, it, vi } from 'vitest';
import { createPlayerService } from '../../../src/app/services/player.js';
import { createPlayerPreferences } from '../../../src/app/services/preferences.js';
import { createMemoryArea } from '../../helpers/memory-area.js';

function setup(overrides = {}) {
  const primary = {
    label: '平台 A',
    resolveStreamUrl: vi.fn(async song => `https://a/${song.id}.mp3`),
    pauseExternalPlayback: vi.fn(async () => {}),
  };
  const other = {
    label: '平台 B',
    resolveStreamUrl: vi.fn(async song => `https://b/${song.id}.mp3`),
    pauseExternalPlayback: vi.fn(async () => {}),
  };
  const providers = {
    primary,
    get: id => (id === 'other' ? other : null),
  };
  const send = vi.fn(async (type, payload) => ({ ok: true, type, payload }));
  const prefs = {
    saveEq: vi.fn(),
    saveEffects: vi.fn(),
    saveVolume: vi.fn(),
    load: vi.fn(async () => ({ volume: 0.5, eq: { bands: [] }, effects: { enabled: true } })),
  };

  const service = createPlayerService({
    send,
    providers,
    prefs,
    defaults: { volume: 0.8 },
    ...overrides,
  });
  return { service, send, providers, primary, other, prefs };
}

describe('createPlayerService 播放控制', () => {
  it('把语义化方法翻译成 offscreen 消息', async () => {
    const { service, send } = setup();

    await service.setPlaylist([{ id: 1 }], false);
    await service.setEq({ bands: [] });
    await service.dispatch('PLAYER_CUSTOM', { a: 1 });

    expect(send).toHaveBeenCalledWith('PLAYER_SET_PLAYLIST', { songs: [{ id: 1 }], autoPlay: false });
    expect(send).toHaveBeenCalledWith('EQ_SET', { eq: { bands: [] } });
    expect(send).toHaveBeenCalledWith('PLAYER_CUSTOM', { a: 1 });
  });
});

describe('createPlayerService 平台解析', () => {
  it('按 song.provider 选择平台', async () => {
    const { service, other } = setup();
    await expect(service.resolveStreamUrl({ id: 1, provider: 'other' }))
      .resolves.toBe('https://b/1.mp3');
    expect(other.resolveStreamUrl).toHaveBeenCalled();
  });

  it('没有 provider 时用主平台', async () => {
    const { service, primary } = setup();
    await expect(service.resolveStreamUrl({ id: 2 })).resolves.toBe('https://a/2.mp3');
    expect(primary.resolveStreamUrl).toHaveBeenCalledWith({ id: 2 });
  });

  it('未知平台与缺失歌曲都抛错', async () => {
    const { service } = setup();
    await expect(service.resolveStreamUrl({ id: 3, provider: 'unknown' }))
      .rejects.toThrow('未注册的音乐平台：unknown');
    await expect(service.resolveStreamUrl()).rejects.toThrow('缺少歌曲信息');
  });

  it('pauseExternal 吞掉平台异常', async () => {
    const { service, primary } = setup();
    primary.pauseExternalPlayback.mockRejectedValueOnce(new Error('平台挂了'));
    await expect(service.pauseExternal()).resolves.toBeUndefined();
  });
});

describe('createPlayerService 偏好', () => {
  it('loadPrefs 读取已保存的音量与 EQ', async () => {
    const { service } = setup();
    await expect(service.loadPrefs()).resolves.toEqual({
      ok: true,
      volume: 0.5,
      eq: { bands: [] },
      effects: { enabled: true },
    });
  });

  it('没有保存过时回落到默认音量', async () => {
    const { service, prefs } = setup();
    prefs.load.mockResolvedValueOnce({ volume: undefined, eq: null, effects: null });

    await expect(service.loadPrefs()).resolves.toEqual({
      ok: true, volume: 0.8, eq: null, effects: null,
    });
  });

  it('saveEq / saveEffects / saveVolume 委托给偏好仓储', () => {
    const { service, prefs } = setup();
    service.saveEq({ bands: [1] });
    service.saveEffects({ enabled: true });
    service.saveVolume(0.3);
    expect(prefs.saveEq).toHaveBeenCalledWith({ bands: [1] });
    expect(prefs.saveEffects).toHaveBeenCalledWith({ enabled: true });
    expect(prefs.saveVolume).toHaveBeenCalledWith(0.3);
  });
});

describe('createPlayerPreferences', () => {
  it('读取不到时返回默认值', async () => {
    const prefs = createPlayerPreferences({ area: createMemoryArea() });
    await expect(prefs.load()).resolves.toEqual({ volume: 0.8, eq: null, effects: null });
  });

  it('写入并读回音量与 EQ', async () => {
    const area = createMemoryArea();
    const prefs = createPlayerPreferences({ area });

    prefs.saveVolume(0.42);
    prefs.saveEq({ bands: [1, 2] });
    prefs.saveEffects({ enabled: true, width: { enabled: true } });
    await new Promise(resolve => setTimeout(resolve, 0));

    await expect(prefs.load()).resolves.toEqual({
      volume: 0.42,
      eq: { bands: [1, 2] },
      effects: { enabled: true, width: { enabled: true } },
    });
  });

  it('忽略非法音量与非空 EQ', async () => {
    const area = createMemoryArea();
    const prefs = createPlayerPreferences({ area });

    prefs.saveVolume(Number.NaN);
    prefs.saveEq(null);
    prefs.saveEffects(null);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(area.snapshot()).toEqual({});
  });
});
