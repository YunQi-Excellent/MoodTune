import { describe, expect, it, vi } from 'vitest';
import { registerBackgroundEvents } from '../../../src/app/background/events.js';
import { FOLDER_SYNC_KEYS } from '../../../src/app/storage/keys.js';

function createChromeStub() {
  const listeners = { installed: [], startup: [], changed: [] };
  const chromeApi = {
    runtime: {
      onInstalled: { addListener: fn => listeners.installed.push(fn) },
      onStartup: { addListener: fn => listeners.startup.push(fn) },
    },
    storage: {
      onChanged: { addListener: fn => listeners.changed.push(fn) },
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
    },
  };
  return { chromeApi, listeners };
}

function setup() {
  const { chromeApi, listeners } = createChromeStub();
  const fs = {
    init: vi.fn(async () => ({ state: 'unbound' })),
    scheduleSync: vi.fn(),
  };
  registerBackgroundEvents({ fs, chromeApi });
  return { fs, listeners, chromeApi };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('registerBackgroundEvents', () => {
  it('注册时打开侧边栏行为并初始化一次', () => {
    const { fs, chromeApi } = setup();

    expect(chromeApi.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(fs.init).toHaveBeenCalledTimes(1);
  });

  it('注册安装与启动监听，二者都会再初始化一次', () => {
    const { fs, listeners } = setup();

    expect(listeners.installed).toHaveLength(1);
    expect(listeners.startup).toHaveLength(1);

    listeners.installed[0]();
    listeners.startup[0]();

    expect(fs.init).toHaveBeenCalledTimes(3);
  });

  it('只在同步键变化时触发文件夹同步', () => {
    const { fs, listeners } = setup();
    const onChanged = listeners.changed[0];

    for (const key of FOLDER_SYNC_KEYS) {
      onChanged({ [key]: {} }, 'local');
    }
    expect(fs.scheduleSync).toHaveBeenCalledTimes(FOLDER_SYNC_KEYS.length);

    fs.scheduleSync.mockClear();
    onChanged({ llmConfig: {} }, 'local');
    onChanged({ [FOLDER_SYNC_KEYS[0]]: {} }, 'session');

    expect(fs.scheduleSync).not.toHaveBeenCalled();
  });

  it('初始化失败不会冒出未处理异常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { chromeApi } = createChromeStub();
    const fs = {
      init: vi.fn(async () => { throw new Error('IndexedDB 不可用'); }),
      scheduleSync: vi.fn(),
    };

    expect(() => registerBackgroundEvents({ fs, chromeApi })).not.toThrow();
    await tick();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('缺少 fs 依赖时立刻报错', () => {
    expect(() => registerBackgroundEvents({})).toThrow('fs 依赖');
  });
});
