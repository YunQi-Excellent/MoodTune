// =====================================================
// 设置页逻辑
// 从普通脚本改成 ES module（为了 import fs-manager.js）
// =====================================================

import { saveHandle, clearHandle } from './fs-manager.js';

const $ = s => document.querySelector(s);
const statusEl = $('#status');

function showStatus(text, kind = 'info') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

/* ================= 大模型配置 ================= */
async function loadConfig() {
  const { llmConfig } = await chrome.storage.local.get('llmConfig');
  if (!llmConfig) return;
  $('#endpoint').value = llmConfig.endpoint || '';
  $('#model').value = llmConfig.model || '';
  // API key 出于安全不回显
}

function originPatternFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

async function saveConfig() {
  const endpoint = $('#endpoint').value.trim();
  const model = $('#model').value.trim();
  const apiKey = $('#apiKey').value.trim();

  if (!endpoint) return showStatus('请填写 Endpoint', 'err');
  if (!model) return showStatus('请填写 Model', 'err');
  if (!apiKey) return showStatus('请填写 API Key', 'err');

  const origin = originPatternFromUrl(endpoint);
  if (!origin) return showStatus('Endpoint 不是合法的 URL', 'err');

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    console.warn('[options] 申请权限失败', e);
  }
  if (!granted) return showStatus(`未获得 ${origin} 的访问权限，配置未保存。`, 'err');

  await chrome.storage.local.set({ llmConfig: { endpoint, model, apiKey } });
  showStatus('✅ 已保存大模型配置', 'ok');
}

async function testConnection() {
  const { llmConfig } = await chrome.storage.local.get('llmConfig');
  if (!llmConfig || !llmConfig.endpoint || !llmConfig.model || !llmConfig.apiKey) {
    return showStatus('请先保存完整配置再测试', 'err');
  }

  showStatus('正在测试…', 'info');
  $('#testBtn').disabled = true;
  try {
    const res = await fetch(llmConfig.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [{ role: 'user', content: '请只回复 JSON：{"ok": true}' }],
        temperature: 0,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('返回里没有 choices[0].message.content');
    showStatus(`✅ 连接成功。模型回复：${content.slice(0, 100)}`, 'ok');
  } catch (e) {
    showStatus(`❌ 测试失败：${e?.message || e}`, 'err');
  } finally {
    $('#testBtn').disabled = false;
  }
}

async function clearConfig() {
  if (!confirm('确定清除本机保存的大模型配置吗？')) return;
  await chrome.storage.local.remove('llmConfig');
  $('#endpoint').value = '';
  $('#model').value = '';
  $('#apiKey').value = '';
  showStatus('已清除大模型配置', 'info');
}

/* ================= 数据文件夹 ================= */
async function refreshFsStatus() {
  const r = await chrome.runtime.sendMessage({ action: 'fsGetStatus' });
  const box = $('#fsStatusBox');
  const title = $('#fsStatusTitle');
  const desc = $('#fsStatusDesc');
  const nameEl = $('#fsStatusName');
  const tree = $('#fileTree');

  box.className = 'fs-status';
  if (!r?.ok) {
    title.textContent = '读取失败';
    desc.textContent = r?.error || '无法连接后台';
    nameEl.textContent = '';
    setFsButtons(false, false, false);
    tree.style.display = 'none';
    return;
  }

  const st = r.state;
  if (st === 'bound') {
    box.classList.add('bound');
    title.textContent = '✅ 已绑定';
    const last = r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString('zh-CN') : '从未';
    desc.textContent = `最近同步：${last}`;
    nameEl.textContent = r.name || '';
    setFsButtons(false, true, true);
    tree.style.display = 'block';
  } else if (st === 'need-permission') {
    box.classList.add('need-permission');
    title.textContent = '⚠️ 需要重新授权';
    desc.textContent = '浏览器重启后权限失效，请点击「绑定文件夹」重新选择同一个文件夹';
    nameEl.textContent = r.name || '';
    setFsButtons(true, false, true);
    tree.style.display = 'none';
  } else if (st === 'denied') {
    box.classList.add('denied');
    title.textContent = '❌ 权限被拒绝';
    desc.textContent = '请点击「绑定文件夹」重新授权';
    nameEl.textContent = r.name || '';
    setFsButtons(true, false, true);
    tree.style.display = 'none';
  } else {
    title.textContent = '未绑定';
    desc.textContent = '点击下方按钮选择一个文件夹来持久化数据';
    nameEl.textContent = '';
    setFsButtons(true, false, false);
    tree.style.display = 'none';
  }
}

function setFsButtons(canBind, canSync, canUnbind) {
  $('#bindFolderBtn').disabled = !canBind;
  $('#syncNowBtn').disabled = !canSync;
  $('#pullFromFolderBtn').disabled = !canSync;
  $('#unbindFolderBtn').disabled = !canUnbind;
}

async function onBindFolder() {
  if (!window.showDirectoryPicker) {
    return showStatus('当前浏览器不支持 File System Access API，请升级 Chrome 到 116+', 'err');
  }
  try {
    // 关键：showDirectoryPicker 必须在用户手势里同步调用
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    // 把 handle 存到 IndexedDB（options 页面和 background 共享同一个 IndexedDB）
    await saveHandle(handle);
    // 通知 background 做绑定后的初始化（首次绑定 push / 已有数据 pull）
    const r = await chrome.runtime.sendMessage({ action: 'fsBindFolder' });
    if (!r?.ok) {
      showStatus('绑定失败：' + (r?.reason || '未知错误'), 'err');
      await refreshFsStatus();
      return;
    }
    const mode = r.mode === 'pull' ? '已从文件夹恢复数据' : '已将当前数据写入文件夹';
    showStatus(`✅ 绑定成功（${mode}）`, 'ok');
    await refreshFsStatus();
  } catch (e) {
    if (e?.name === 'AbortError') return;  // 用户取消
    showStatus('绑定失败：' + (e?.message || e), 'err');
  }
}

async function onSyncNow() {
  $('#syncNowBtn').disabled = true;
  showStatus('正在同步…', 'info');
  try {
    const r = await chrome.runtime.sendMessage({ action: 'fsSyncNow' });
    if (!r?.ok) {
      // 特殊处理：空覆盖被阻止
      if (r?.reason === 'empty-would-overwrite') {
        showStatus('⚠️ ' + (r.message || '当前插件数据为空，已阻止覆盖文件夹'), 'info');
        return;
      }
      throw new Error(r?.reason || r?.message || '未知错误');
    }
    const dir = r.direction === 'pull' ? '📥 从文件夹恢复' :
                r.direction === 'push' ? '📤 上传到文件夹' : '（无需同步）';
    showStatus(`✅ ${dir}：${r.message || ''}`, 'ok');
  } catch (e) {
    showStatus('同步失败：' + (e?.message || e), 'err');
  } finally {
    await refreshFsStatus();
  }
}

async function onPullFromFolder() {
  if (!confirm('从文件夹恢复会覆盖当前插件里的数据，确定继续？')) return;
  $('#pullFromFolderBtn').disabled = true;
  showStatus('正在从文件夹读取…', 'info');
  try {
    const r = await chrome.runtime.sendMessage({ action: 'fsPullFromFolder' });
    if (!r?.ok) throw new Error(r?.reason || '未知错误');
    showStatus(`✅ 已恢复（${(r.pulledKeys || []).join(', ')}）`, 'ok');
  } catch (e) {
    showStatus('恢复失败：' + (e?.message || e), 'err');
  } finally {
    await refreshFsStatus();
  }
}

async function onUnbindFolder() {
  if (!confirm('解绑后数据不再同步到文件夹，文件夹里的 JSON 不会被删除。继续？')) return;
  try {
    await clearHandle();
    const r = await chrome.runtime.sendMessage({ action: 'fsUnbindFolder' });
    if (!r?.ok) throw new Error(r?.reason || '未知错误');
    showStatus('✅ 已解绑', 'ok');
    await refreshFsStatus();
  } catch (e) {
    showStatus('解绑失败：' + (e?.message || e), 'err');
  }
}

/* ================= 事件绑定 ================= */
$('#saveBtn').addEventListener('click', saveConfig);
$('#testBtn').addEventListener('click', testConnection);
$('#clearBtn').addEventListener('click', clearConfig);
$('#bindFolderBtn').addEventListener('click', onBindFolder);
$('#syncNowBtn').addEventListener('click', onSyncNow);
$('#pullFromFolderBtn').addEventListener('click', onPullFromFolder);
$('#unbindFolderBtn').addEventListener('click', onUnbindFolder);

/* ================= 启动 ================= */
(async () => {
  await loadConfig();
  await refreshFsStatus();
})();