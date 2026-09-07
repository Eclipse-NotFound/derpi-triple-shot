// ==UserScript==
// @name         Derpi Triple Shot — derpibooru 一键三连
// @namespace    local.derpi.triple.shot
// @version      0.1.0
// @description  一键 收藏+点赞+下载：浮动按钮、搜索网格目标记忆、成功后自动回搜索页。三连=发一次站内收藏请求（derpibooru 源码已证：收藏自带点赞、重复点无害）+ 按站内原版文件名下载原图。
// @author       you
// @match        https://derpibooru.org/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      derpibooru.org
// @connect      derpicdn.net
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * 里程碑备注（0.1.0 = M1 骨架）：
 *  - 核心链路按 philomena 源码事实编写；页面选择器（SEL）待 fixtures 验证后收口。
 *  - Tampermonkey 菜单里的「自检当前页面」是远程排障主工具：装上后先跑它。
 *  - 下载建议把 Tampermonkey 设置 → 下载模式 选 Browser（浏览器），子目录才生效。
 */

(function () {
  'use strict';

  /* ===================== 配置区（改这里即可） ===================== */
  const CONFIG = {
    downloadSubfolder: 'derpi',      // 存到浏览器默认下载目录下的子文件夹；'' = 直接存下载根目录
    filenameFallback:  'derpi_{id}', // 拿不到站内原版文件名时的退化模板（自动补扩展名）
    autoBack:          true,         // 详情页三连成功后自动回上一页（搜索页）
    autoBackDelayMs:   [1000, 3000], // 随机等待区间（毫秒）；想固定 1.5 秒写 [1500, 1500]
    buttonDefault:     { xPct: 96, yPct: 40 }, // 首次出现位置（视口百分比）；拖动后自动记忆
    debug:             true,         // 控制台 [DTS] 日志
  };
  /* ===================== 配置区结束 ===================== */

  const LOG = (...a) => { if (CONFIG.debug) console.log('[DTS]', ...a); };

  /* 选择器候选链：按顺序试，命中即用。待 fixtures 验证后收口。 */
  const SEL = {
    csrf:          ['meta[name="csrf-token"]', 'meta[name="csrf"]'],
    detailImage:   ['#image-container', 'div.image-container[data-image-id]'],
    imageIdAttr:   'data-image-id',
    downloadLink:  ['a[href*="/img/download/"]', 'a[href*="/img/view/"]'],
    favePostLink:  ['a.interaction--fave[href$="/fave"][data-method="post"]', 'a.interaction--fave'],
    thumbImage:    'div.image-container[data-image-id]',
  };

  const first = (list) => {
    for (const s of list) { const el = document.querySelector(s); if (el) return el; }
    return null;
  };

  /* ---------------- 状态 ---------------- */
  const state = {
    targetEl: null,   // 网格页当前目标缩略图元素
    targetId: null,   // 其图片 ID
    busy: false,
  };

  /* ---------------- 页面判定与信息提取 ---------------- */

  function pageKind() {
    if (/\/images\/\d+/.test(location.pathname) && first(SEL.detailImage)) return 'detail';
    if (document.querySelector(SEL.thumbImage)) return 'grid';
    return 'other';
  }

  function getCsrf() {
    const m = first(SEL.csrf);
    return m ? (m.getAttribute('content') || null) : null;
  }

  /* 详情页上下文：ID、防伪暗号、页面自带的下载直链、站内收藏链接 */
  function detailContext() {
    const el = first(SEL.detailImage);
    let id = el && el.getAttribute(SEL.imageIdAttr);
    if (!id) {
      const m = location.pathname.match(/\/images\/(\d+)/);
      if (m) id = m[1];
    }
    const dl = first(SEL.downloadLink);
    const fave = first(SEL.favePostLink);
    return {
      id,
      csrf: getCsrf(),
      downloadUrl: dl ? dl.href : null,
      faveUrl: fave ? fave.href : null, // 页面自己的收藏链接（data-method="post" 时）优先采用
    };
  }

  /* ---------------- 收藏（自带点赞） ---------------- */

  async function postFave(ctx) {
    if (!ctx.csrf) throw new Error('页面里找不到防伪暗号(CSRF)');
    const url = ctx.faveUrl || `/images/${ctx.id}/fave`;
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': ctx.csrf, 'Accept': 'application/json' },
    });
    // 未登录时站内会 302 到登录页，fetch 跟随后表现为 HTML 响应
    if (r.redirected || /\/sessions|\/login/.test(r.url || '')) {
      throw new Error('未登录——请先登录 derpibooru 再用三连');
    }
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('json')) throw new Error(`站内返回 ${r.status}（${ct || '未知类型'}）`);
    return r.json(); // { score, faves, upvotes, downvotes }
  }

  /* ---------------- 下载 ---------------- */

  function fetchImageJson(id) {
    return fetch(`/api/v1/json/images/${id}`, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then((data) => data.image || (data.images && data.images[0]));
  }

  /* GM_xmlhttpRequest 发 HEAD，读 Content-Disposition 里的站内原版文件名 */
  function headFilename(url) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') return resolve(null);
      GM_xmlhttpRequest({
        method: 'HEAD',
        url,
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 400) return resolve(null);
          const line = String(res.responseHeaders || '')
            .split(/\r?\n/)
            .find((l) => /^content-disposition:/i.test(l));
          resolve(parseFilename(line));
        },
        onerror:   () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  function parseFilename(cd) {
    if (!cd) return null;
    const star = cd.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/);
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch (e) { /* fallthrough */ } }
    const plain = cd.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1].trim() : null;
  }

  /* 下载直链候选：详情页自带链接 → JSON representations.full 的 /img/download/ 变体（待验证）→ full 本体 */
  async function resolveDownload(ctx) {
    const cands = [];
    if (ctx.downloadUrl) cands.push(ctx.downloadUrl);
    if (cands.length === 0 || !/\/img\/download\//.test(cands[0])) {
      try {
        const img = await fetchImageJson(ctx.id);
        const full = img && img.representations && img.representations.full;
        if (full) {
          cands.push(full.replace('/img/view/', '/img/download/')); // 🧪 该变体待线上验证
          cands.push(full);
        }
      } catch (e) { LOG('取图片 JSON 失败：', e.message); }
    }
    for (const url of cands) {
      const name = await headFilename(url);
      if (name) return { url, name };
    }
    const url = cands[cands.length - 1];
    if (!url) throw new Error('找不到下载直链');
    const m = url.split('?')[0].match(/\.(\w{2,5})$/);
    return { url, name: `${CONFIG.filenameFallback.replace('{id}', ctx.id)}.${m ? m[1] : 'png'}` };
  }

  function gmDownload(url, name) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== 'function') {
        return reject(new Error('GM_download 不可用——检查 Tampermonkey「允许用户脚本」开关'));
      }
      GM_download({ url, name,
        onload: () => resolve(name),
        onerror: (e) => reject(new Error('下载失败：' + ((e && (e.error || e.message)) || '未知原因'))),
      });
    });
  }

  async function downloadImage(ctx) {
    const { url, name } = await resolveDownload(ctx);
    const target = (CONFIG.downloadSubfolder ? CONFIG.downloadSubfolder + '/' : '') + name;
    try {
      await gmDownload(url, target);
      return { name: target };
    } catch (e) {
      LOG('子目录下载失败，退化平铺：', e.message);
      const flat = 'derpi_' + name;
      await gmDownload(url, flat);
      return { name: flat, degraded: true };
    }
  }

  /* ---------------- 三连主流程 ---------------- */

  async function triShot(ctx) {
    if (!ctx.id) throw new Error('找不到图片 ID');
    const inter = await postFave(ctx);       // 源码已证：收藏自带点赞，重复点无害
    const dl = await downloadImage(ctx);
    return { inter, dl };
  }

  /* ---------------- 自动回搜索页 ---------------- */

  function scheduleAutoBack() {
    if (!CONFIG.autoBack) return;
    try {
      const ref = document.referrer || '';
      const sameSite = ref.includes(location.hostname); // 来路必须是站内页（搜索页），外来客不送
      if (!sameSite) { toast('已完成（无站内来路，不自动返回）'); return; }
      const [a, b] = CONFIG.autoBackDelayMs;
      const delay = Math.round(a + Math.random() * Math.max(0, b - a));
      setTimeout(() => {
        if (history.length > 1) {
          history.back();                    // 同标签打开 → 回搜索页
        } else {
          window.close();                    // 新标签打开 → 尽力关闭（浏览器只放行脚本开的标签）
        }
      }, delay);
    } catch (e) { LOG('自动返回失败：', e); }
  }

  /* ---------------- 浮动按钮 UI ---------------- */

  let btn, face, resetTimer = null;

  function buildButton() {
    btn = document.createElement('div');
    btn.id = 'dts-btn';
    face = document.createElement('div');
    face.className = 'dts-face';
    face.textContent = '⚡';
    btn.appendChild(face);
    btn.title = '三连：收藏+点赞+下载（可拖动）';
    document.body.appendChild(btn);
    restorePos();
    attachDragAndClick();
  }

  function restorePos() {
    const saved = GM_getValue('btnPos', null);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      btn.style.left = clamp(saved.x, 8, innerWidth - 62) + 'px';
      btn.style.top  = clamp(saved.y, 8, innerHeight - 62) + 'px';
    } else {
      btn.style.left = (innerWidth  * CONFIG.buttonDefault.xPct / 100 - 27) + 'px';
      btn.style.top  = (innerHeight * CONFIG.buttonDefault.yPct / 100 - 27) + 'px';
    }
  }
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function attachDragAndClick() {
    let down = null, dragged = false;
    btn.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, bx: btn.offsetLeft, by: btn.offsetTop };
      dragged = false;
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) dragged = true;
      if (dragged) {
        btn.style.left = clamp(down.bx + dx, 8, innerWidth - 62) + 'px';
        btn.style.top  = clamp(down.by + dy, 8, innerHeight - 62) + 'px';
      }
    });
    btn.addEventListener('pointerup', () => {
      if (down && dragged) GM_setValue('btnPos', { x: btn.offsetLeft, y: btn.offsetTop });
      else if (down) onClickButton();
      down = null;
    });
  }

  async function onClickButton() {
    if (state.busy) return;
    const kind = pageKind();
    let ctx;
    if (kind === 'detail') {
      ctx = detailContext();
    } else if (kind === 'grid') {
      if (!state.targetId) { toast('先把鼠标停在某张图上，再点三连'); return; }
      ctx = { id: state.targetId, csrf: getCsrf(), downloadUrl: null, faveUrl: null };
    } else {
      toast('本页不是图片页/搜索页');
      return;
    }
    setFace('busy');
    state.busy = true;
    try {
      await triShot(ctx);
      setFace('ok');
      toast(`三连成功 #${ctx.id} ✓`);
      LOG('成功：', ctx.id);
      if (kind === 'detail') scheduleAutoBack();
    } catch (e) {
      setFace('fail');
      toast('三连失败：' + e.message);
      LOG('失败：', e);
    } finally {
      state.busy = false;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => setFace('idle'), 2500);
    }
  }

  function setFace(s) {
    btn.classList.remove('dts-idle', 'dts-busy', 'dts-ok', 'dts-fail');
    btn.classList.add('dts-' + s);
    face.textContent = { idle: '⚡', busy: '⏳', ok: '✓', fail: '✕' }[s];
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'dts-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('dts-show'), 10);
    setTimeout(() => { t.classList.remove('dts-show'); setTimeout(() => t.remove(), 400); }, 3000);
  }

  /* ---------------- 网格页目标记忆 ---------------- */

  document.addEventListener('mouseover', (e) => {
    if (pageKind() !== 'grid' || !e.target || !e.target.closest) return;
    const c = e.target.closest('div.image-container[data-image-id]');
    if (!c || c === state.targetEl) return;
    if (state.targetEl) state.targetEl.classList.remove('dts-target');
    state.targetEl = c;
    state.targetId = c.getAttribute(SEL.imageIdAttr);
    c.classList.add('dts-target');
    if (face) face.textContent = '⚡';
    LOG('目标锁定 #' + state.targetId);
  });

  /* ---------------- 自检（Tampermonkey 菜单） ---------------- */

  function runSelfTest() {
    const kind = pageKind();
    const csrf = !!getCsrf();
    const detail = first(SEL.detailImage);
    const detailId = detail && detail.getAttribute(SEL.imageIdAttr);
    const dlLink = !!first(SEL.downloadLink);
    const faveLink = first(SEL.favePostLink);
    const thumbs = document.querySelectorAll(SEL.thumbImage).length;
    const gms = {
      GM_download: typeof GM_download === 'function',
      GM_xmlhttpRequest: typeof GM_xmlhttpRequest === 'function',
    };
    const lines = [
      `页面类型: ${kind}`,
      `防伪暗号(CSRF): ${csrf ? '✓' : '✗ 找不到'}`,
      `详情图容器: ${detail ? '✓ id=' + detailId : '—'}`,
      `下载直链: ${dlLink ? '✓' : '—'}`,
      `收藏链接: ${faveLink ? '✓ ' + faveLink.getAttribute('href') : '—'}`,
      `网格缩略图数量: ${thumbs}`,
      `GM_download: ${gms.GM_download ? '✓' : '✗（开「允许用户脚本」）'}`,
      `GM_xmlhttpRequest: ${gms.GM_xmlhttpRequest ? '✓' : '✗（开「允许用户脚本」）'}`,
    ];
    console.log('[DTS] 自检结果 ────────\n' + lines.join('\n'));
    toast('自检完成，看 Tampermonkey 控制台/弹窗');
    alert('[Derpi Triple Shot 自检]\n\n' + lines.join('\n'));
  }

  /* ---------------- 样式 ---------------- */

  const _addStyle = typeof GM_addStyle === 'function'
    ? GM_addStyle
    : (css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
  _addStyle(`
    #dts-btn {
      position: fixed; z-index: 2147483000; width: 54px; height: 54px;
      border-radius: 50%; display: flex; align-items: center; justify-content: center;
      cursor: grab; user-select: none; touch-action: none;
      background: #2b2b3c; color: #fff; font-size: 24px;
      box-shadow: 0 2px 10px rgba(0,0,0,.45);
      opacity: .45; transition: opacity .15s, background .15s;
      border: 2px solid transparent;
    }
    #dts-btn:hover { opacity: .95; cursor: grab; }
    #dts-btn.dts-busy { background: #b8860b; opacity: .95; }
    #dts-btn.dts-ok   { background: #2e9e44; opacity: 1; }  /* 全成功=绿 */
    #dts-btn.dts-fail { background: #cc3333; opacity: 1; }  /* 任一失败=红 */
    .dts-target { outline: 3px solid #35c65a !important; outline-offset: 2px; border-radius: 4px; }
    .dts-toast {
      position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%) translateY(12px);
      background: rgba(20,20,30,.92); color: #fff; padding: 9px 16px; border-radius: 8px;
      font-size: 13px; z-index: 2147483001; opacity: 0; transition: all .3s;
      pointer-events: none; max-width: 70vw;
    }
    .dts-toast.dts-show { opacity: 1; transform: translateX(-50%) translateY(0); }
  `);

  /* ---------------- 启动 ---------------- */

  function main() {
    if (typeof GM_getValue !== 'function' || typeof GM_download !== 'function') {
      console.warn('[DTS] GM 功能不可用——大概率是 Chrome 的「允许用户脚本」没开（见 README 排障第 1 条）。');
    }
    const kind = pageKind();
    if (kind === 'other') { LOG('非图片/搜索页，按钮不出现'); return; }
    buildButton();
    setFace('idle');
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('▶️ 自检当前页面', runSelfTest);
      GM_registerMenuCommand('🎯 重置按钮位置', () => { GM_setValue('btnPos', null); restorePos(); toast('按钮位置已重置'); });
    }
    LOG('就绪，页面类型：', kind);
  }

  main();
})();
