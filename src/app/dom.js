/** 扩展页面共用的 DOM 查询 helpers（侧边栏 / 设置页）。 */
export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
