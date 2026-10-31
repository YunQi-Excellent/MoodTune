import { describe, expect, it, vi } from 'vitest';
import { createSessionService } from '../../../src/app/services/sessions.js';
import { createSessionStore } from '../../../src/app/storage/sessions.js';
import { createMemoryArea } from '../../helpers/memory-area.js';

const NOW = 1_700_000_000_000;
const FLAT_EQ = { preampDb: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

function setup() {
  const area = createMemoryArea();
  let seq = 0;
  const newId = prefix => `${prefix}-${++seq}`;
  const store = createSessionStore({ area, now: () => NOW, newId });
  const player = {
    setEq: vi.fn(async eq => ({ ok: true, eq })),
    getEq: vi.fn(async () => ({ ok: true, eq: null })),
    setPlaylist: vi.fn(async () => ({ ok: true })),
    pauseExternal: vi.fn(async () => {}),
  };
  const service = createSessionService({
    store,
    player,
    normalizeSong: song => ({ ...song, normalized: true }),
    defaultEq: () => FLAT_EQ,
    newId,
    now: () => NOW,
  });
  return { area, store, player, service };
}

describe('createSessionService 购物车', () => {
  it('add 归一化歌曲并去重', async () => {
    const { store, service } = setup();
    const session = await store.create('购物车');

    await service.cart.add(session.id, [{ id: 1 }, { id: 2 }]);
    const result = await service.cart.add(session.id, [{ id: 2 }, { id: 3 }]);

    expect(result).toEqual({ added: 1, total: 3 });
    const fresh = await store.get(session.id);
    expect(fresh.cart.map(song => song.id)).toEqual([1, 2, 3]);
    expect(fresh.cart.every(song => song.normalized)).toBe(true);
  });

  it('add 传空数组时返回 null', async () => {
    const { service } = setup();
    expect(await service.cart.add('any', [])).toBeNull();
  });

  it('remove / reorder / clear', async () => {
    const { store, service } = setup();
    const session = await store.create('购物车');
    await service.cart.add(session.id, [{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(await service.cart.remove(session.id, [2])).toEqual({ total: 2 });
    expect(await service.cart.reorder(session.id, [3, 1])).toEqual({ total: 2 });
    expect((await store.get(session.id)).cart.map(song => song.id)).toEqual([3, 1]);
    expect(await service.cart.clear(session.id)).toEqual({ total: 0 });
  });

  it('settle 应用调音、暂停外部播放并保存结果快照', async () => {
    const { store, player, service } = setup();
    const session = await store.create('结算');
    await service.cart.add(session.id, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

    const eq = { preampDb: -2, bands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    await service.cart.setEq(session.id, eq);

    const result = await service.cart.settle(session.id);

    expect(result).toMatchObject({ ok: true, count: 2 });
    expect(player.setEq).toHaveBeenCalledWith(eq);
    expect(player.pauseExternal).toHaveBeenCalled();
    expect(player.setPlaylist).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 1 })]),
      true,
    );

    const fresh = await store.get(session.id);
    expect(fresh.songCount).toBe(2);
    expect(fresh.result).toMatchObject({ eq, settledAt: NOW });
    expect(fresh.result.playlist).toHaveLength(2);
  });

  it('settle 没有 cartEq 时不调用 setEq', async () => {
    const { store, player, service } = setup();
    const session = await store.create('结算');
    await service.cart.add(session.id, [{ id: 1 }]);

    await service.cart.settle(session.id);
    expect(player.setEq).not.toHaveBeenCalled();
  });

  it('settle 空购物车报错，未知会话也报错', async () => {
    const { store, service } = setup();
    const session = await store.create('空');
    await expect(service.cart.settle(session.id)).rejects.toThrow('会话歌单是空的');
    await expect(service.cart.settle('不存在')).rejects.toThrow('找不到会话');
  });
});

describe('createSessionService 恢复', () => {
  it('restore 应用快照里的调音与歌单，并把会话设为当前', async () => {
    const { store, player, service } = setup();
    const session = await store.create('恢复');
    const eq = { preampDb: 1, bands: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0] };
    await store.update(session.id, {
      result: { eq, playlist: [{ id: 1 }, { id: 2 }] },
    });
    await store.create('别的会话');

    const restored = await service.restore(session.id);

    expect(restored).toMatchObject({ eq, songCount: 2 });
    expect(restored.messages).toContain('已应用调音快照');
    expect(await store.currentId()).toBe(session.id);
    expect(player.setEq).toHaveBeenCalledWith(eq);
    expect(player.setPlaylist).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }], true);
  });

  it('restore 没有快照时回退到旧字段', async () => {
    const { store, player, service } = setup();
    const session = await store.create('旧会话');
    const eq = { preampDb: 0, bands: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    await store.update(session.id, { eq, playlistSnapshot: [{ id: 9 }] });

    const restored = await service.restore(session.id);

    expect(restored).toMatchObject({ eq, songCount: 1 });
    expect(player.setPlaylist).toHaveBeenCalledWith([{ id: 9 }], true);
  });

  it('restore 未知会话报错', async () => {
    const { service } = setup();
    await expect(service.restore('不存在')).rejects.toThrow('找不到会话');
  });
});

describe('createSessionService EQ 面板与结果来源', () => {
  it('openEqPanel 没有会话时新建，并插入 eq-card', async () => {
    const { store, service } = setup();

    const { messageId } = await service.openEqPanel();

    const session = await store.getCurrent();
    expect(session).not.toBeNull();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      id: messageId,
      kind: 'eq-card',
      eq: FLAT_EQ,
    });
  });

  it('openEqPanel 优先使用会话里的 cartEq', async () => {
    const { store, service } = setup();
    const session = await store.create('调音');
    const eq = { preampDb: 2, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    await store.update(session.id, { cartEq: eq });

    await service.openEqPanel();

    const fresh = await store.get(session.id);
    expect(fresh.messages[0].eq).toEqual(eq);
  });

  it('updateResultSource 只改来源字段', async () => {
    const { store, service } = setup();
    const session = await store.create('来源');
    await store.update(session.id, { result: { playlist: [], eq: null } });

    await service.updateResultSource(session.id, {
      playlistSource: 'model', eqSource: 'preset',
    });

    const fresh = await store.get(session.id);
    expect(fresh.result).toMatchObject({ playlistSource: 'model', eqSource: 'preset' });
  });

  it('updateResultSource 没有结果时抛错', async () => {
    const { store, service } = setup();
    const session = await store.create('空');
    await expect(service.updateResultSource(session.id, { playlistSource: 'x' }))
      .rejects.toThrow('会话或结果不存在');
    await expect(service.updateResultSource('不存在', { playlistSource: 'x' }))
      .rejects.toThrow('会话或结果不存在');
  });
});
