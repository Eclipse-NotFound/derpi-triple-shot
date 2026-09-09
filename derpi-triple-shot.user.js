// ==UserScript==
// @name         Derpi Triple Shot — derpibooru 一键三连
// @namespace    local.derpi.triple.shot
// @version      1.1.0
// @description  一键 收藏+点赞+下载（derpibooru）：F/D/E 快捷键 + 浮动按钮。收藏走站内原生（自带点赞、重复点无害），按站内原版文件名下载原图到 下载/derpi/。
// @author       you
// @match        https://derpibooru.org/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * Derpi Triple Shot v1.0.0（发布版）
 *
 * 键位：F = 三连（站内原生收藏+点赞，插件补下载；详情页完成后自动返回）
 *       D = 网格：进入悬停图详情页；详情：返回上一页
 *       E = 网格：翻到下一页
 *       W = 尝试关闭当前标签（best-effort：浏览器仅放行脚本弹出的标签，被拒时浮条提示）
 * 按钮：左键 = 三连（详情/网格统一）；详情页右键 = 返回；可拖动、位置记忆
 * 菜单：⏱ 设置自动返回延时（持久化）｜🎯 重置按钮位置
 * 下载：浏览器默认下载目录/derpi/，站内原版文件名（超长自动截断）
 * 默认 dispatch 模式：收藏+下载请求发出即走，不等回包（详情页约 0.3–0.6 秒后自动返回）
 *
 * 调试仪器（活动日志/自检/时间戳）已从发布版移除；
 * 实现细节、选型依据与排障方法见 docs/方案定稿.md 与 git 历史。
 */

(function () {
  'use strict';

  /* ===================== 配置区（改这里即可） ===================== */
  const CONFIG = {
    downloadSubfolder: 'derpi',      // 下载子目录；'' = 直接存下载根目录
    autoBack:          true,         // 详情页三连成功后自动回上一页
    autoBackDelayMs:   [300, 600],  // 返回前停顿区间（毫秒）；菜单可设固定值；真·秒回写 [0, 0]
    buttonDefault:     { xPct: 96, yPct: 40 }, // 按钮首次位置（视口百分比）；拖动后自动记忆
    triShotTiming:     'dispatch',  // 'dispatch' 发出即走（默认）| 'stagger' 错峰 | 'parallel' 并行 | 'serial' 串行
    hotkey:            'f',         // 三连键
    navHotkey:         'd',         // 导航键
    pageHotkey:        'e',         // 翻页键
    closeHotkey:       'w',         // 关闭当前标签（best-effort：被浏览器拒绝时浮条提示原生快捷键）
    staggerMs:         300,         // 收藏先发车、下载晚 staggerMs 毫秒（错峰用）
  };

  /* 键盘监听在 document-start 挂到 window 捕获期——先于站方快捷键处理器（站方会抢 F/E，见 git 历史 0.2.8） */
  let booted = false;
  window.addEventListener('keydown', (e) => {
    if (!booted) return;
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const key = (e.key || '').toLowerCase();
    const isF = key === CONFIG.hotkey;
    const isD = key === CONFIG.navHotkey;
    const isE = key === CONFIG.pageHotkey;
    const isW = key === CONFIG.closeHotkey;
    if (!isF && !isD && !isE && !isW) return;
    if (isTextTarget(e.target)) return;                    // 搜索框/编辑器打字不触发
    const kind = pageKind();
    if (kind === 'grid' && !state.targetId) {
      const c = e.target.closest && e.target.closest('div.image-container[data-image-id]');
      if (c) setTargetFromEl(c);                            // 悬停追踪滞后时现场锁定
    }
    if (isW) {
      closeTab();                                           // W：best-effort 关闭当前标签
    } else if (isE) {
      if (kind === 'grid') gotoRelPage(+1);
    } else if (isF) {                                      // F：站内原生收藏/点赞 + 插件补下载
      if (kind === 'detail') runHotkey(detailContext(), true);
      else if (kind === 'grid' && state.targetId) runHotkey(gridContext(), false);
    } else {                                               // D
      if (kind === 'detail') goBackNow();
      else if (kind === 'grid' && state.targetId) openTarget();
    }
  }, true);

  /* 选择器——已按真实页面 fixtures 收口（实测✓） */
  const SEL = {
    csrf:          ['meta[name="csrf-token"]', 'meta[name="csrf"]'],
    detailImage:   ['div.image-show-container[data-image-id]', 'div.image-container[data-image-id]'],
    imageIdAttr:   'data-image-id',
    // 详情页两枚下载链：首枚=带标签文件名版（站内“下载”主按钮同款），次枚=纯 ID 版
    downloadLink:  'a[href*="/img/download/"]',
    urisAttr:      'data-uris', // 网格缩略图容器 JSON：{"full":"…/img/view/…png",…}
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
    token: 0,         // 竞态护栏：返回前作废一切在途流程的迟到回写
  };

  /* ---------------- 页面判定与信息提取 ---------------- */

  function pageKind() {
    if (/\/images\/\d+/.test(location.pathname)) return 'detail';   // URL 权威，query 任意
    if (document.querySelector(SEL.thumbImage)) return 'grid';
    return 'other';
  }

  function getCsrf() {
    const m = first(SEL.csrf);
    return m ? (m.getAttribute('content') || null) : null;
  }

  /* 详情页上下文：ID 取自 URL，防伪暗号 + 站内下载直链（第一枚=带标签文件名版） */
  function detailContext() {
    const m = location.pathname.match(/\/images\/(\d+)/);
    const el = first(SEL.detailImage);
    const id = (m && m[1]) || (el && el.getAttribute(SEL.imageIdAttr));
    const dl = document.querySelector(SEL.downloadLink);
    return { id, csrf: getCsrf(), downloadUrl: dl ? dl.href : null, viewUrl: null };
  }

  /* ---------------- 收藏（自带点赞） ---------------- */

  /* fixtures 实证：站内收藏按钮是 href="#" 假链接；提交地址按站内路由构造，
   * 暗号走表单参数 _csrf_token（站内 form 惯例）+ X-CSRF-Token 头双保险。 */
  async function postFave(ctx) {
    if (!ctx.csrf) throw new Error('页面里找不到防伪暗号(CSRF)');
    const r = await fetch(`/images/${ctx.id}/fave`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-CSRF-Token': ctx.csrf,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: `_csrf_token=${encodeURIComponent(ctx.csrf)}`,
    });
    // 未登录时站内会 302 到登录页，fetch 跟随后表现为重定向
    if (r.redirected || /\/sessions|\/login/.test(r.url || '')) {
      throw new Error('未登录——请先登录 derpibooru 再用三连');
    }
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('json')) throw new Error(`站内返回 ${r.status}（${ct || '未知类型'}）——刷新页面重试`);
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

  /* 站内下载直链的文件名就编码在 URL 尾段（+ 号即空格），无需再问服务器 */
  function filenameFromUrl(url, id) {
    const seg = url.split('?')[0].split('/').pop() || `${id}.png`;
    let name = seg;
    try { name = decodeURIComponent(seg.replace(/\+/g, ' ')); } catch (e) { /* 保留原样 */ }
    if (!/\.\w{2,5}$/.test(name)) name += '.png';
    // 截断超长文件名（带标签版可达 220+ 字符），避免路径超长导致下载失败
    if (name.length > 150) {
      const m = name.match(/\.\w{2,5}$/);
      name = name.slice(0, 150 - (m ? m[0].length : 0)) + (m ? m[0] : '');
    }
    return name;
  }

  /* 下载直链优先级：详情页站内下载链（带标签文件名版）→ 网格 data-uris 的 view→download 替换 → JSON API 兜底 */
  async function resolveDownload(ctx) {
    let url = ctx.downloadUrl;
    if (!url && ctx.viewUrl) url = ctx.viewUrl.replace('/img/view/', '/img/download/');
    if (!url) {
      try {
        const img = await fetchImageJson(ctx.id);
        const full = img && img.representations && img.representations.full;
        if (full) url = full.replace('/img/view/', '/img/download/');
      } catch (e) { /* 走下一步兜底 */ }
    }
    if (!url) throw new Error('找不到下载直链');
    return { url, name: filenameFromUrl(url, ctx.id) };
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

  /* dispatch 专用：下载入队即算数——chrome.downloads 在浏览器进程传输，页面冻结不影响 */
  async function dispatchDownload(ctx) {
    if (typeof GM_download !== 'function') throw new Error('GM_download 不可用——检查「允许用户脚本」开关');
    const { url, name } = await resolveDownload(ctx);
    const target = (CONFIG.downloadSubfolder ? CONFIG.downloadSubfolder + '/' : '') + name;
    gmDownload(url, target).catch(() => {});   // 单次尝试不重试（重试=双下载）；失败由浏览器下载栏呈现
    return { name: target };
  }

  async function downloadImage(ctx) {
    const { url, name } = await resolveDownload(ctx);
    const target = (CONFIG.downloadSubfolder ? CONFIG.downloadSubfolder + '/' : '') + name;
    try {
      await gmDownload(url, target);
      return { name: target };
    } catch (e) {
      const flat = 'derpi_' + name;              // 子目录不可用时退化平铺
      await gmDownload(url, flat);
      return { name: flat, degraded: true };
    }
  }

  /* ---------------- 三连主流程 ---------------- */

  /* dispatch=发出即走（默认）。代价：页面返回即冻结，收藏回包无人回读——失败静默，
   * 用发出前登录预检堵住最大的坑；下载走 chrome.downloads，页面冻结不影响。 */
  async function triShot(ctx) {
    if (!ctx.id) throw new Error('找不到图片 ID');
    const mode = CONFIG.triShotTiming;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

    if (mode === 'dispatch') {
      if (!document.querySelector('a[href="/sessions"][data-method="delete"]')) {
        throw new Error('未登录——dispatch 模式无法事后报告，已拒绝发出（请先登录，或把 triShotTiming 改回 stagger）');
      }
      postFave(ctx).catch(() => {});   // 发出即结案（页面冻结后回包不回读）
      await wait(CONFIG.staggerMs);    // 给收藏请求留出带宽头筹
      let dl;
      try { dl = await dispatchDownload(ctx); } catch (e) { throw new Error('下载未发出：' + e.message); }
      return { inter: null, dl, dispatched: true };
    }

    const faveP = settle(postFave(ctx).then((r) => r));
    const dlP = settle((async () => {
      if (mode === 'stagger') await wait(CONFIG.staggerMs);
      else if (mode === 'serial') await faveP;
      return downloadImage(ctx);
    })());
    const [f, d] = await Promise.all([faveP, dlP]);
    const errs = [];
    if (!f.ok) errs.push('收藏/点赞：' + f.e.message);
    if (!d.ok) errs.push('下载：' + d.e.message);
    if (errs.length) throw new Error(errs.join('；') + '｜另一路已完成');
    return { inter: f.v, dl: d.v };
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
    btn.title = '左键=三连（详情/网格统一）；详情右键=返回；可拖动；三连也可走 F 键';
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
      if (e.button !== 0) return;   // 仅左键参与拖动/点击判定，右键/中键完全惰性
      down = { x: e.clientX, y: e.clientY, bx: btn.offsetLeft, by: btn.offsetTop, button: e.button };
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
    btn.addEventListener('pointerup', (e) => {
      if (down && dragged) GM_setValue('btnPos', { x: btn.offsetLeft, y: btn.offsetTop });
      else if (down && e.button === 0) onLeftClick();   // 右键走 contextmenu，不在这里触发
      down = null;
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();                                  // 按钮上压掉浏览器右键菜单
      if (pageKind() === 'detail') goBackNow();            // 详情页右键=返回；网格右键无动作
    });
  }

  /* 左键=三连（详情/网格统一） */
  function onLeftClick() {
    if (state.busy) return;
    onClickButton();
  }

  /* 返回护栏：先作废在途流程、锁按钮，30ms 后离场——防止页面冻结进缓存后，
   * 半路流程的回调在解冻边界继续执行（曾造成“返回顺带下载”） */
  function backNow(quiet) {
    const ref = document.referrer || '';
    if (!ref.includes(location.hostname)) {
      if (!quiet) toast('本页没有站内来路，不返回（新标签可手动关）');
      return;
    }
    state.token++;                          // 作废所有在途流程的迟到回写
    state.busy = true;                      // 冻结期内新点击全部拒绝
    clearTimeout(resetTimer);
    if (btn) setFace('busy');
    setTimeout(() => {
      if (history.length > 1) history.back();
      else window.close();
    }, 30);
  }

  function goBackNow() { backNow(false); }

  function scheduleAutoBack() {
    if (!CONFIG.autoBack) return;
    const ref = document.referrer || '';
    if (!ref.includes(location.hostname)) { toast('已完成（无站内来路，不自动返回）'); return; }
    // 菜单设置的固定延时优先（存脚本存储）；未设置则用配置区间随机
    const fixed = (typeof GM_getValue === 'function') ? GM_getValue('backDelayMs', null) : null;
    const [a, b] = (typeof fixed === 'number' && Number.isFinite(fixed)) ? [fixed, fixed] : CONFIG.autoBackDelayMs;
    const delay = Math.round(a + Math.random() * Math.max(0, b - a));
    const token = state.token;
    setTimeout(() => { if (token === state.token) backNow(true); }, delay);
  }

  async function onClickButton() {
    if (state.busy) return;
    const kind = pageKind();
    let ctx;
    if (kind === 'detail') {
      ctx = detailContext();
    } else if (kind === 'grid') {
      if (!state.targetId) { toast('先把鼠标停在某张图上，再点三连'); return; }
      ctx = gridContext();
    } else {
      toast('本页不是图片页/搜索页');
      return;
    }
    setFace('busy');
    state.busy = true;
    try {
      const res = await triShot(ctx);
      setFace('ok');
      if (res.dispatched) {
        toast(`三连已发出 #${ctx.id} ✓（不等回包，即将返回）`);
      } else {
        const i = res.inter || {};
        toast(`三连成功 #${ctx.id} ✓（服务器回包：收藏 ${i.faves ?? '?'}，得分 ${i.score ?? '?'}）`);
      }
      if (kind === 'detail') scheduleAutoBack();
    } catch (e) {
      setFace('fail');
      toast('三连失败：' + e.message);
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

  function setTargetFromEl(c) {
    if (!c || c === state.targetEl) return;
    if (state.targetEl) state.targetEl.classList.remove('dts-target');
    state.targetEl = c;
    state.targetId = c.getAttribute(SEL.imageIdAttr);
    c.classList.add('dts-target');
    if (face) face.textContent = '⚡';
  }

  document.addEventListener('mouseover', (e) => {
    if (pageKind() !== 'grid' || !e.target || !e.target.closest) return;
    setTargetFromEl(e.target.closest('div.image-container[data-image-id]'));
  });

  /* BFCache 恢复清理：清掉冻结前残留的锁定目标与忙态，避免返回瞬间合成点击落在旧目标上 */
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;                 // 只处理从缓存恢复（back/forward 解冻）
    state.targetEl = null;
    state.targetId = null;
    state.busy = false;
    state.token++;
    if (btn) setFace('idle');
  });

  /* ---------------- 键盘三连：F=站内原生收藏/点赞，本插件补下载（详情页附返回） ---------------- */

  function isTextTarget(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function gridContext() {
    let viewUrl = null;
    try { viewUrl = JSON.parse(state.targetEl.getAttribute(SEL.urisAttr)).full; } catch (e) { /* 走 API 兜底 */ }
    return { id: state.targetId, csrf: getCsrf(), downloadUrl: null, viewUrl };
  }

  /* 网格 D：优先用缩略图自己的链接（保留 ?q= 浏览上下文），退化纯 ID */
  function openTarget() {
    const a = state.targetEl && state.targetEl.querySelector('a[href^="/images/"]');
    location.assign(a ? a.getAttribute('href') : '/images/' + state.targetId);
  }

  /* E 键：搜索/标签页翻到下一页（沿用站内 a.js-next） */
  function gotoRelPage(dir) {
    const a = dir > 0 ? document.querySelector('a.js-next') : document.querySelector('a.js-prev');
    if (!a) { toast(dir > 0 ? '已是最后一页' : '已是第一页'); return; }
    location.assign(a.getAttribute('href'));
  }

  /* W 键：best-effort 关闭当前标签。Chrome 只放行"脚本弹出的标签"；
   * 若真关掉了，页面随即销毁、下方定时器永不触发；若 250ms 后页面还活着 = 被拒，浮条明示。 */
  function closeTab() {
    window.close();
    setTimeout(() => {
      toast('浏览器拒绝关闭此标签（非脚本弹出）——请用 Ctrl+W / Alt+F4');
    }, 250);
  }

  async function runHotkey(ctx, withBack) {
    if (state.busy || !ctx.id) return;
    if (!document.querySelector('a[href="/sessions"][data-method="delete"]')) {
      toast('未登录——站内原生 F 收藏不会生效，下载已跳过');
      return;
    }
    state.busy = true;
    setFace('busy');
    try {
      await dispatchDownload(ctx);   // 入队即结案；下载由浏览器进程完成，页面返回冻结不影响
      setFace('ok');
      toast(`三连已发出 #${ctx.id} ✓（收藏=站内原生，下载已入队）`);
      if (withBack) scheduleAutoBack();
    } catch (e) {
      setFace('fail');
      toast('快捷键三连失败：' + e.message);
    } finally {
      state.busy = false;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => setFace('idle'), 2500);
    }
  }

  /* ---------------- 菜单（用户可调项） ---------------- */

  /* 延时设置：输入即存（毫秒，0-60000），留空恢复默认区间 */
  function setBackDelayMenu() {
    const cur = GM_getValue('backDelayMs', null);
    const v = window.prompt(
      '三连/按 F 后自动返回前的等待毫秒数。\n0 = 立即返回；留空 = 恢复默认（配置区 autoBackDelayMs 区间随机）。\n当前：' +
      (typeof cur === 'number' ? cur + 'ms（固定）' : '默认区间'),
      typeof cur === 'number' ? String(cur) : '');
    if (v === null) return;                    // 取消
    if (v.trim() === '') { GM_setValue('backDelayMs', null); toast('已恢复默认返回延时'); return; }
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 60000) { toast('无效数值（应为 0–60000 毫秒）'); return; }
    GM_setValue('backDelayMs', n);
    toast('返回延时已设为 ' + n + 'ms，立即生效');
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
      console.warn('[DTS] GM 功能不可用——大概率是 Chrome 的「允许用户脚本」没开。');
    }
    buildButton();
    setFace('idle');
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('⏱ 设置自动返回延时', setBackDelayMenu);
      GM_registerMenuCommand('🎯 重置按钮位置', () => { GM_setValue('btnPos', null); restorePos(); toast('按钮位置已重置'); });
    }
    booted = true;   // 初始化完成后开放 document-start 早挂的键盘监听
  }

  function boot() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
    else main();
  }
  boot();
})();