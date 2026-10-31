import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNeteaseExternalPlayer } from '../../src/app/background/netease-external-player.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createNeteaseExternalPlayer', () => {
  it('暂停所有网易云标签页里的 audio', async () => {
    const query = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
    const executeScript = vi.fn(async () => {});

    vi.stubGlobal('chrome', {
      tabs: { query },
      scripting: { executeScript },
    });

    await createNeteaseExternalPlayer().pause();

    expect(query).toHaveBeenCalledWith({ url: 'https://music.163.com/*' });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0][0]).toMatchObject({
      target: { tabId: 1 },
      func: expect.any(Function),
    });
  });

  it('查询标签页失败时静默跳过', async () => {
    vi.stubGlobal('chrome', {
      tabs: { query: async () => { throw new Error('no permission'); } },
      scripting: { executeScript: async () => {} },
    });

    await expect(createNeteaseExternalPlayer().pause()).resolves.toBeUndefined();
  });
});
