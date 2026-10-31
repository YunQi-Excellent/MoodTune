const NETEASE_TAB_PATTERN = 'https://music.163.com/*';

/**
 * 网易云网页播放器的外部控制适配器。
 * 这是扩展宿主专属能力：provider 只依赖 { pause() }，不直接碰 chrome.*。
 * @returns {{pause: () => Promise<void>}}
 */
export function createNeteaseExternalPlayer() {
  return {
    async pause() {
      try {
        const tabs = await chrome.tabs.query({ url: NETEASE_TAB_PATTERN });
        for (const tab of tabs) {
          if (tab?.id === undefined) continue;
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                document.querySelectorAll('audio').forEach(audio => {
                  try { audio.pause(); } catch {}
                });
              },
            });
          } catch {}
        }
      } catch {}
    },
  };
}
