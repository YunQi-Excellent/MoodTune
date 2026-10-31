/**
 * EQ 预设与直接调音。
 *
 * getEqState / setEqDirect / resetEq 是侧边栏滑杆的直连通道，
 * 其余四个是预设的增删改与套用。
 */
export function createEqHandlers({ presets, player }) {
  if (!presets || !player) throw new Error('createEqHandlers 需要 presets / player');

  return {
    listEqPresets: async () => ({ ok: true, presets: await presets.list() }),

    saveEqPreset: async (req) => {
      let eq = req.eq;
      if (!eq) {
        const current = await player.getEq();
        if (!current?.ok || !current.eq) throw new Error('读不到当前 EQ');
        eq = current.eq;
      }
      const saved = await presets.save({
        name: req.name || '未命名调音',
        eq,
        source: 'manual',
      });
      return { ok: true, preset: saved };
    },

    deleteEqPreset: async (req) => ({
      ok: true,
      presets: await presets.remove(req.id),
    }),

    renameEqPreset: async (req) => ({
      ok: true,
      presets: await presets.rename(req.id, req.name),
    }),

    applyEqPreset: async (req) => ({ ok: true, ...(await presets.apply(req.id)) }),

    getEqState: async () => (await player.getEq()) || { ok: false },

    setEqDirect: async (req) => (await player.setEq(req.eq)) || { ok: true },

    resetEq: async () => (await player.resetEq()) || { ok: true },
  };
}
