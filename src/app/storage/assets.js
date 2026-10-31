import { createId } from '../../core/ids.js';
import { storageQueue } from './storage-queue.js';

const NAME_LIMIT = 60;

/**
 * 列表型资产仓储（保存的播放列表 / EQ 预设）。
 *
 * 两者结构一致：`{ id, name, createdAt, source, ...payload }` 的数组，
 * 新条目插到最前面，超出上限时截断。所有写操作都在 storage 队列里执行，
 * 并发保存不会互相覆盖。
 *
 * @param {object} options
 * @param {{ get: Function, set: Function, remove: Function }} options.area
 * @param {string} options.key storage 键名
 * @param {number} [options.limit]
 * @param {string} [options.idPrefix]
 * @param {string} [options.notFoundMessage]
 * @param {string} [options.defaultName]
 * @param {{ run: Function }} [options.queue]
 * @param {() => number} [options.now]
 * @param {(prefix: string) => string} [options.newId]
 */
export function createAssetStore({
  area,
  key,
  limit = 100,
  idPrefix = 'asset',
  notFoundMessage = '找不到这条数据',
  defaultName = '未命名',
  queue = storageQueue,
  now = Date.now,
  newId = prefix => createId(prefix, now()),
} = {}) {
  if (!area || typeof area.get !== 'function') {
    throw new Error('createAssetStore 需要 storage area');
  }
  if (!key) throw new Error('createAssetStore 需要 storage key');

  const readList = async () => {
    const data = await area.get(key);
    return Array.isArray(data?.[key]) ? data[key] : [];
  };
  const writeList = list => area.set({ [key]: list });
  const transaction = task => queue.run(key, task);

  const normalizeName = value => String(value || defaultName).trim().slice(0, NAME_LIMIT) || defaultName;

  return {
    list() {
      return transaction(readList);
    },

    get(id) {
      return transaction(async () => {
        const list = await readList();
        return list.find(item => item.id === id) || null;
      });
    },

    /**
     * @param {{ name?: string, source?: string } & Record<string, unknown>} payload
     */
    add(payload = {}) {
      return transaction(async () => {
        const list = await readList();
        const { name, source = 'manual', ...fields } = payload;
        const item = {
          ...fields,
          id: newId(idPrefix),
          name: normalizeName(name),
          createdAt: now(),
          source,
        };
        list.unshift(item);
        if (list.length > limit) list.length = limit;
        await writeList(list);
        return item;
      });
    },

    remove(id) {
      return transaction(async () => {
        const list = await readList();
        const next = list.filter(item => item.id !== id);
        await writeList(next);
        return next;
      });
    },

    /** 改名并返回整个列表（侧边栏直接拿列表重渲染）。 */
    rename(id, name) {
      return transaction(async () => {
        const list = await readList();
        const target = list.find(item => item.id === id);
        if (!target) throw new Error(notFoundMessage);
        target.name = normalizeName(name);
        await writeList(list);
        return list;
      });
    },

    update(id, patch) {
      return transaction(async () => {
        const list = await readList();
        const target = list.find(item => item.id === id);
        if (!target) throw new Error(notFoundMessage);
        Object.assign(target, patch);
        await writeList(list);
        return target;
      });
    },

    /** 整表替换（供「从文件夹恢复」使用）。 */
    replaceAll(items) {
      return transaction(async () => {
        const list = Array.isArray(items) ? items : [];
        await writeList(list);
        return list;
      });
    },
  };
}
