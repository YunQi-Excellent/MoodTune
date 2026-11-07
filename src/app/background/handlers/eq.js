/**
 * 调音相关处理器。
 *
 * 两组东西走同一个通道：
 * - 直连：getEqState / setEqDirect / resetEq（滑杆）、getEffectsState / setEffectsDirect / resetEffects
 * - 自定义预设的增删改与套用（内置音效在 handlers/sound.js）
 *
 * 套用预设后用户仍然可以拖滑杆微调 —— 那只是改 EQ 这一个节点，
 * 效果链保持不变，所以「预设之上自由调整」天然成立。
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
      const payload = {
        name: req.name || '未命名调音',
        eq,
        source: 'manual',
      };
      if (req.effects) payload.effects = req.effects;

      const saved = await presets.save(payload);
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

    /* ---- 效果链直连：与 EQ 同一通道，侧边栏/Agent 都走这里 ---- */
    getEffectsState: async () => (await player.getEffects()) || { ok: false },

    setEffectsDirect: async (req) => (await player.setEffects(req.effects)) || { ok: true },

    resetEffects: async () => (await player.resetEffects()) || { ok: true },
  };
}
