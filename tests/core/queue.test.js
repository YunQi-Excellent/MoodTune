import { describe, expect, it } from 'vitest';
import { createKeyedQueue, createSerialQueue } from '../../src/core/queue.js';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe('createSerialQueue', () => {
  it('按提交顺序串行执行', async () => {
    const queue = createSerialQueue();
    const events = [];

    const first = queue.run(async () => {
      events.push('a:start');
      await tick(20);
      events.push('a:end');
      return 'a';
    });
    const second = queue.run(async () => {
      events.push('b:start');
      return 'b';
    });

    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('任务抛错后队列继续可用，错误原样抛给提交者', async () => {
    const queue = createSerialQueue();

    await expect(queue.run(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.run(() => 42)).resolves.toBe(42);
  });

  it('size 反映未完成任务数', async () => {
    const queue = createSerialQueue();
    expect(queue.size).toBe(0);

    const first = queue.run(async () => { await tick(10); });
    const second = queue.run(async () => { await tick(10); });
    expect(queue.size).toBe(2);

    await Promise.all([first, second]);
    expect(queue.size).toBe(0);
  });
});

describe('createKeyedQueue', () => {
  it('同一个 key 串行，不同 key 并行', async () => {
    const queue = createKeyedQueue();
    const events = [];

    const x1 = queue.run('x', async () => {
      events.push('x1:start');
      await tick(20);
      events.push('x1:end');
    });
    const x2 = queue.run('x', async () => {
      events.push('x2:start');
    });
    const y = queue.run('y', async () => {
      events.push('y:start');
    });

    await Promise.all([x1, x2, y]);
    expect(events).toEqual(['x1:start', 'y:start', 'x1:end', 'x2:start']);
  });

  it('一个 key 失败不影响其他 key，也不阻断同 key 的后续任务', async () => {
    const queue = createKeyedQueue();

    await expect(queue.run('a', () => { throw new Error('a 失败'); })).rejects.toThrow('a 失败');
    await expect(queue.run('a', () => 'next')).resolves.toBe('next');
    await expect(queue.run('b', () => 'other')).resolves.toBe('other');
  });

  it('size 按 key 统计，key 清空后归零', async () => {
    const queue = createKeyedQueue();

    const a = queue.run('a', async () => { await tick(10); });
    const b = queue.run('a', async () => { await tick(10); });
    const c = queue.run('c', async () => { await tick(10); });

    expect(queue.size('a')).toBe(2);
    expect(queue.size('c')).toBe(1);
    expect(queue.total).toBe(3);

    await Promise.all([a, b, c]);
    expect(queue.size('a')).toBe(0);
    expect(queue.total).toBe(0);
  });
});
