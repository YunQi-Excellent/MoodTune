import { describe, expect, it } from 'vitest';
import { EQ_FREQUENCIES } from '../../src/core/constants.js';
import { EQ_TUNER_SYSTEM } from '../../prompts.js';

describe('EQ 调音提示词', () => {
  it('频段列表来自 core 常量，避免提示词与音频引擎漂移', () => {
    expect(EQ_TUNER_SYSTEM).toContain(EQ_FREQUENCIES.join(', '));
  });
});
