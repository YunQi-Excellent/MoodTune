import { describe, expect, it } from 'vitest';
import { createSessionStore, CURRENT_SESSION_KEY, SESSIONS_KEY } from '../../../src/app/storage/sessions.js';
import { createMemoryArea } from '../../helpers/memory-area.js';

const NOW = 1_700_000_000_000;

function setup(options = {}) {
  const area = createMemoryArea({ delay: options.delay ?? 0 });
  let seq = 0;
  const store = createSessionStore({
    area,
    now: () => NOW,
    newId: prefix => `${prefix}-${++seq}`,
    maxSessions: options.maxSessions,
    maxMessages: options.maxMessages,
  });
  return { area, store };
}

function message(id, text = 'hi') {
  return { id, role: 'user', kind: 'text', text, at: NOW };
}

describe('createSessionStore 基本读写', () => {
  it('需要 storage area', () => {
    expect(() => createSessionStore()).toThrow('storage area');
  });

  it('create 写入会话并设为当前', async () => {
    const { area, store } = setup();
    const session = await store.create('写代码');

    expect(session).toMatchObject({
      name: '写代码',
      messages: [],
      cart: [],
      result: null,
      songCount: 0,
    });
    expect(await store.currentId()).toBe(session.id);
    expect(area.snapshot()[SESSIONS_KEY]).toHaveLength(1);
    expect(area.snapshot()[CURRENT_SESSION_KEY]).toBe(session.id);
  });

  it('create 使用默认名并截断超长名称', async () => {
    const { store } = setup();
    expect((await store.create('   ')).name).toBe('新会话');
    expect((await store.create('长'.repeat(80))).name).toHaveLength(40);
  });

  it('create 超出上限时丢弃最旧的会话', async () => {
    const { store } = setup({ maxSessions: 2 });
    const first = await store.create('一');
    const second = await store.create('二');
    const third = await store.create('三');

    const list = await store.list();
    expect(list.map(s => s.id)).toEqual([third.id, second.id]);
    expect(list.some(s => s.id === first.id)).toBe(false);
  });

  it('switchTo 切换当前会话，找不到时抛错', async () => {
    const { store } = setup();
    const a = await store.create('a');
    const b = await store.create('b');

    await expect(store.switchTo(a.id)).resolves.toMatchObject({ id: a.id });
    expect(await store.currentId()).toBe(a.id);
    await expect(store.switchTo('不存在')).rejects.toThrow('找不到这个会话');
    expect(await store.currentId()).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  it('remove 删除会话，并在删掉当前会话时切到下一个', async () => {
    const { area, store } = setup();
    const a = await store.create('a');
    const b = await store.create('b');

    await store.remove(b.id);
    expect((await store.list()).map(s => s.id)).toEqual([a.id]);
    expect(await store.currentId()).toBe(a.id);

    await store.remove(a.id);
    expect(await store.list()).toEqual([]);
    expect(area.snapshot()).not.toHaveProperty(CURRENT_SESSION_KEY);
  });

  it('rename 改名校验存在性', async () => {
    const { store } = setup();
    const session = await store.create('旧名字');

    await expect(store.rename(session.id, '新名字')).resolves.toMatchObject({ name: '新名字' });
    await expect(store.rename('不存在', 'x')).rejects.toThrow('找不到会话');
    expect((await store.rename(session.id, '  ')).name).toBe('未命名');
  });

  it('get / getCurrent / currentId 处理空存储与悬空 id', async () => {
    const { area, store } = setup();
    expect(await store.list()).toEqual([]);
    expect(await store.currentId()).toBeNull();
    expect(await store.getCurrent()).toBeNull();
    expect(await store.get('nope')).toBeNull();

    await area.set({ [CURRENT_SESSION_KEY]: 'dangling' });
    expect(await store.getCurrent()).toBeNull();
  });

  it('update 合并字段，未知会话返回 null', async () => {
    const { store } = setup();
    const session = await store.create('a');

    await expect(store.update(session.id, { songCount: 3 })).resolves.toMatchObject({ songCount: 3 });
    expect(await store.update('不存在', { songCount: 1 })).toBeNull();
  });

  it('replaceAll 整表替换，并按需更新当前会话', async () => {
    const { store } = setup();
    await store.create('旧');

    const restored = [{ id: 'sess-9', name: '恢复的', createdAt: NOW, messages: [], cart: [] }];
    await store.replaceAll(restored, 'sess-9');
    expect(await store.list()).toEqual(restored);
    expect(await store.currentId()).toBe('sess-9');

    await store.replaceAll([], undefined);
    expect(await store.list()).toEqual([]);
    expect(await store.currentId()).toBe('sess-9');
  });
});

describe('createSessionStore 消息', () => {
  it('appendMessage 追加消息并去重相同 id', async () => {
    const { store } = setup();
    const session = await store.create('a');

    await store.appendMessage(session.id, message('m1'));
    await store.appendMessage(session.id, message('m1'));
    await store.appendMessage(session.id, message('m2'));

    const fresh = await store.get(session.id);
    expect(fresh.messages.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('appendMessage 超过上限时保留最新的消息', async () => {
    const { store } = setup({ maxMessages: 2 });
    const session = await store.create('a');

    for (const id of ['m1', 'm2', 'm3']) await store.appendMessage(session.id, message(id));

    const fresh = await store.get(session.id);
    expect(fresh.messages.map(m => m.id)).toEqual(['m2', 'm3']);
  });

  it('appendMessage 在会话不存在时自动创建', async () => {
    const { store } = setup();

    const created = await store.appendMessage('sess-unknown', message('m1'));

    expect(created).toMatchObject({ id: 'sess-unknown', name: '新会话' });
    expect(created.messages).toHaveLength(1);
    expect((await store.list()).map(s => s.id)).toEqual(['sess-unknown']);
  });
});

describe('createSessionStore 并发', () => {
  it('并发追加消息不会丢写', async () => {
    const { store } = setup({ delay: 1 });
    const session = await store.create('并发');

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendMessage(session.id, message(`m${i}`))),
    );

    const fresh = await store.get(session.id);
    expect(fresh.messages).toHaveLength(20);
    expect(new Set(fresh.messages.map(m => m.id)).size).toBe(20);
  });

  it('并发 mutate 的读改写不会互相覆盖', async () => {
    const { store } = setup({ delay: 1 });
    const session = await store.create('计数器');

    await Promise.all(Array.from({ length: 10 }, () => store.mutate(session.id, target => {
      target.counter = (target.counter || 0) + 1;
    })));

    expect((await store.get(session.id)).counter).toBe(10);
  });

  it('并发创建会话都会保留，当前会话指向其中之一', async () => {
    const { store } = setup({ delay: 1 });

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.create(`会话${i}`)),
    );

    const list = await store.list();
    expect(list).toHaveLength(10);
    expect(new Set(list.map(s => s.id)).size).toBe(10);
    expect(created.map(s => s.id)).toContain(await store.currentId());
  });

  it('mutate 未知会话抛错', async () => {
    const { store } = setup();
    await expect(store.mutate('不存在', () => {})).rejects.toThrow('找不到会话');
  });
});
