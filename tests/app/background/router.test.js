import { describe, expect, it } from 'vitest';
import { createMessageRouter } from '../../../src/app/background/router.js';

/** 模拟 chrome.runtime.onMessage 的调用方式：同步拿 handled，异步拿响应。 */
function call(route, message) {
  return new Promise((resolve) => {
    let handled;
    let settled = false;
    handled = route(message, { id: 'sender' }, (response) => {
      settled = true;
      resolve({ handled, response });
    });
    if (handled !== true && !settled) resolve({ handled, response: undefined });
  });
}

function setup() {
  const seen = [];
  const route = createMessageRouter({
    actions: {
      listSessions: async req => ({ ok: true, tag: 'listSessions', id: req.id }),
      boom: () => { throw new Error('炸了'); },
      silent: () => undefined,
      passthrough: () => ({ ok: false, reason: 'empty-would-overwrite' }),
    },
    types: {
      PLAYER_STATE_CHANGED: req => ({ ok: true, tag: 'state', payload: req.payload }),
      PLAYER_GET_STATE: async () => ({ ok: true, tag: 'exact' }),
    },
    typePrefixes: [
      { prefix: 'PLAYER_', handle: async req => { seen.push(req.type); return { ok: true, tag: 'prefix' }; } },
    ],
  });
  return { route, seen };
}

describe('createMessageRouter', () => {
  it('按 action 分发并透传响应', async () => {
    const { route } = setup();
    const { handled, response } = await call(route, { action: 'listSessions', id: 7 });

    expect(handled).toBe(true);
    expect(response).toEqual({ ok: true, tag: 'listSessions', id: 7 });
  });

  it('target=background 的 type 精确匹配优先于前缀', async () => {
    const { route, seen } = setup();
    const { response } = await call(route, { target: 'background', type: 'PLAYER_GET_STATE' });

    expect(response).toEqual({ ok: true, tag: 'exact' });
    expect(seen).toEqual([]);
  });

  it('未注册的 PLAYER_* 落到前缀处理器', async () => {
    const { route, seen } = setup();
    const { response } = await call(route, { target: 'background', type: 'PLAYER_SEEK' });

    expect(response).toEqual({ ok: true, tag: 'prefix' });
    expect(seen).toEqual(['PLAYER_SEEK']);
  });

  it('type 未匹配时继续尝试 action', async () => {
    const { route } = setup();
    const { response } = await call(route, {
      target: 'background', type: 'UNKNOWN', action: 'listSessions', id: 1,
    });

    expect(response).toEqual({ ok: true, tag: 'listSessions', id: 1 });
  });

  it('未注册的消息返回 false，不占用消息通道', async () => {
    const { route } = setup();
    const { handled, response } = await call(route, { action: 'nope' });

    expect(handled).toBe(false);
    expect(response).toBeUndefined();
  });

  it('处理器抛错转成 { ok: false, error }', async () => {
    const { route } = setup();
    const { response } = await call(route, { action: 'boom' });

    expect(response).toEqual({ ok: false, error: '炸了' });
  });

  it('返回 undefined 视为 { ok: true }', async () => {
    const { route } = setup();
    const { response } = await call(route, { action: 'silent' });

    expect(response).toEqual({ ok: true });
  });

  it('处理器自己返回的失败响应原样透传', async () => {
    const { route } = setup();
    const { response } = await call(route, { action: 'passthrough' });

    expect(response).toEqual({ ok: false, reason: 'empty-would-overwrite' });
  });

  it('响应是异步发送的，处理器可以 await', async () => {
    const { route } = setup();
    let respondedSynchronously = true;
    const promise = new Promise((resolve) => {
      route({ action: 'listSessions' }, {}, (response) => {
        expect(respondedSynchronously).toBe(false);
        resolve(response);
      });
    });
    respondedSynchronously = false;

    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('忽略非对象消息', async () => {
    const { route } = setup();
    expect(await call(route, null)).toEqual({ handled: false, response: undefined });
  });
});
