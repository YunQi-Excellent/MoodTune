import { describe, expect, it } from 'vitest';
import { createAssetStore } from '../../../src/app/storage/assets.js';
import { createMemoryArea } from '../../helpers/memory-area.js';

const NOW = 1_700_000_000_000;
const KEY = 'savedPlaylists';

function setup(options = {}) {
  const area = createMemoryArea({ delay: options.delay ?? 0 });
  let seq = 0;
  const store = createAssetStore({
    area,
    key: KEY,
    limit: options.limit,
    idPrefix: 'pl',
    notFoundMessage: '找不到这个播放列表',
    now: () => NOW,
    newId: prefix => `${prefix}-${++seq}`,
  });
  return { area, store };
}

describe('createAssetStore', () => {
  it('需要 storage area 和 key', () => {
    expect(() => createAssetStore()).toThrow('storage area');
    expect(() => createAssetStore({ area: createMemoryArea() })).toThrow('storage key');
  });

  it('add 新条目排在最前面并补齐通用字段', async () => {
    const { area, store } = setup();

    const first = await store.add({ name: '晚上', songs: [{ id: 1 }] });
    const second = await store.add({ name: '早上', source: 'agent', songs: [] });

    expect(first).toMatchObject({ id: 'pl-1', name: '晚上', source: 'manual', createdAt: NOW });
    expect(second).toMatchObject({ id: 'pl-2', source: 'agent' });
    expect((await store.list()).map(item => item.id)).toEqual(['pl-2', 'pl-1']);
    expect(area.snapshot()[KEY]).toHaveLength(2);
  });

  it('add 使用默认名并截断超长名称', async () => {
    const { store } = setup();
    expect((await store.add({})).name).toBe('未命名');
    expect((await store.add({ name: '名'.repeat(80) })).name).toHaveLength(60);
  });

  it('超出上限时丢弃最旧的条目', async () => {
    const { store } = setup({ limit: 2 });
    await store.add({ name: '一' });
    await store.add({ name: '二' });
    await store.add({ name: '三' });

    expect((await store.list()).map(item => item.name)).toEqual(['三', '二']);
  });

  it('rename 返回整个列表，找不到时抛出定制提示', async () => {
    const { store } = setup();
    const item = await store.add({ name: '旧' });

    const list = await store.rename(item.id, '新');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('新');

    await expect(store.rename('不存在', 'x')).rejects.toThrow('找不到这个播放列表');
  });

  it('remove 与 get', async () => {
    const { store } = setup();
    const a = await store.add({ name: 'a' });
    const b = await store.add({ name: 'b' });

    expect(await store.get(a.id)).toMatchObject({ name: 'a' });
    expect(await store.get('不存在')).toBeNull();

    const next = await store.remove(a.id);
    expect(next.map(item => item.id)).toEqual([b.id]);
    expect(await store.list()).toHaveLength(1);
  });

  it('update 合并字段', async () => {
    const { store } = setup();
    const item = await store.add({ name: 'a', songs: [] });

    await expect(store.update(item.id, { songs: [{ id: 1 }] }))
      .resolves.toMatchObject({ name: 'a', songs: [{ id: 1 }] });
    await expect(store.update('不存在', {})).rejects.toThrow('找不到这个播放列表');
  });

  it('replaceAll 整表替换', async () => {
    const { store } = setup();
    await store.add({ name: '旧' });

    await store.replaceAll([{ id: 'pl-9', name: '恢复的' }]);
    expect((await store.list()).map(item => item.id)).toEqual(['pl-9']);
  });

  it('并发 add 不会丢写', async () => {
    const { store } = setup({ delay: 1 });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.add({ name: `歌单${i}`, songs: [] })),
    );

    const list = await store.list();
    expect(list).toHaveLength(10);
    expect(new Set(list.map(item => item.id)).size).toBe(10);
  });
});
