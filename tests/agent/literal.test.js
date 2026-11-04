import { describe, expect, it } from 'vitest';
import { coreQuery, isLiteralHit, normalizeForMatch } from '../../src/agent/literal.js';

describe('normalizeForMatch', () => {
  it('小写并去掉空白与标点', () => {
    expect(normalizeForMatch(' 霓虹 下的·酒神 (EP) ')).toBe('霓虹下的酒神ep');
  });
});

describe('coreQuery', () => {
  it('剥掉 op/ed/主题曲 这类版本后缀', () => {
    expect(coreQuery('酒神op')).toBe('酒神');
    expect(coreQuery('酒神 OP')).toBe('酒神');
    expect(coreQuery('酒神主题曲')).toBe('酒神');
  });

  it('不把歌名本身剥没', () => {
    expect(coreQuery('op')).toBe('op');
    expect(coreQuery('霓虹下的酒神')).toBe('霓虹下的酒神');
  });

  it('剥完后缀后残留的连接词也要去掉（P4D的op → p4d）', () => {
    expect(coreQuery('P4D的op')).toBe('p4d');
    expect(coreQuery('酒神的op')).toBe('酒神');
    expect(coreQuery('P4D 的 OST')).toBe('p4d');
  });
});

describe('isLiteralHit', () => {
  it('检索词落在歌名里就算命中（酒神op → 霓虹下的酒神）', () => {
    expect(isLiteralHit('酒神op', { name: '霓虹下的酒神', album: '霓虹下的酒神 EP', artists: '某' }))
      .toBe(true);
  });

  it('缩写落在专辑名里也能命中（p4d → Persona4 DANCING ALL NIGHT）', () => {
    expect(isLiteralHit('p4d', {
      name: 'Your Affection (“NEVER MORE”P4D-EDIT ver.)',
      album: 'Persona4 DANCING ALL NIGHT Original Soundtrack',
      artists: '平田志穂子',
    })).toBe(true);
  });

  it('歌手 + 歌名分开也能命中（周杰伦的晴天 → 晴天）', () => {
    expect(isLiteralHit('周杰伦的晴天', { name: '晴天', album: '叶惠美', artists: '周杰伦' }))
      .toBe(true);
  });

  it('氛围长句不会被短歌名误命中（深夜写代码 ≠ 深夜）', () => {
    expect(isLiteralHit('深夜写代码', { name: '深夜', album: 'X', artists: 'Y' })).toBe(false);
  });

  it('完全不相关时不命中', () => {
    expect(isLiteralHit('酒神op', { name: '晴天', album: '叶惠美', artists: '周杰伦' }))
      .toBe(false);
  });

  it('两字符英文缩写不做命中，避免 op/ed 泛滥', () => {
    expect(isLiteralHit('op', { name: 'OP', album: '', artists: '' })).toBe(false);
  });
});
