import { FOLDER_SYNC_KEYS } from '../storage/keys.js';

/**
 * 扩展级事件：安装/启动、侧边栏行为、storage 变化触发文件夹同步。
 *
 * 依赖注入 chromeApi 便于在没有浏览器环境的测试里验证注册顺序与过滤条件。
 *
 * @param {object} options
 * @param {{ init: Function, scheduleSync: Function }} options.fs
 * @param {object} [options.chromeApi]
 * @param {string[]} [options.syncKeys] 变化后需要同步到文件夹的 storage 键
 */
export function registerBackgroundEvents({
  fs,
  chromeApi = globalThis.chrome,
  syncKeys = FOLDER_SYNC_KEYS,
} = {}) {
  if (!fs) throw new Error('registerBackgroundEvents 需要 fs 依赖');
  if (!chromeApi) throw new Error('registerBackgroundEvents 需要 chrome API');

  const openPanelOnActionClick = () => {
    chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  };

  const initOnce = (label) => {
    fs.init().catch(e => console.warn(`[fs-sync] ${label} initFs 失败：`, e));
  };

  chromeApi.runtime.onInstalled.addListener(() => {
    openPanelOnActionClick();
    initOnce('onInstalled');
  });

  chromeApi.runtime.onStartup.addListener(() => {
    openPanelOnActionClick();
    initOnce('onStartup');
  });

  openPanelOnActionClick();

  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!syncKeys.some(key => key in changes)) return;
    fs.scheduleSync();
  });

  // service worker 每次被唤醒也尝试初始化一次（幂等）
  initOnce('启动');
}
