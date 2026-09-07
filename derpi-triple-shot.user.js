// ==UserScript==
// @name         Derpi Triple Shot — derpibooru 一键三连
// @namespace    local.derpi.triple.shot
// @version      0.1.5
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
 * 里程碑备注（0.1.5 = 三种时序开关 + 分阶段时间戳；吸收 0.1.4 复盘教训）：
 *  - 0.1.4 纯并行的代价：大图下载与收藏请求同时抢代理带宽，收藏回包反而变慢。
 *  - 0.1.5 默认「错峰」：收藏先发、下载延后 staggerMs(300ms) 再走——两头都快；
 *    可切 'parallel'/'serial' 对比；每阶段耗时打进控制台 [DTS·T]，速度问题用数据定案。
 *  - 403 病根确诊：站内收藏按钮 a.interaction--fave 是 href="#" 的假链接（JS 动态处理），
 *    0.1.1 拿它当提交地址打到了错误路由。修复：一律 POST /images/<id>/fave，
 *    暗号按站内惯例走表单参数 _csrf_token + X-CSRF-Token 头双保险。
 *  - 下载直链实证：详情页 a[href*="/img/download/"] 首枚=带标签文件名版（站内"下载"主按钮同款，
 *    + 号即空格）；网格容器自带 data-uris JSON，/img/view/→/img/download/ 替换成立（🧪转正）。
 *  - 0.1.1：详情页判定改 URL 权威、按钮/自检菜单全页常开（0.1.0 详情页误判修复）。
 *  - 下载模式=浏览器 API 已设好（子目录生效的前提）。
 */

(function () {
  'use strict';

  /* ===================== 配置区（改这里即可） ===================== */
  const CONFIG = {
    downloadSubfolder: 'derpi',      // 存到浏览器默认下载目录下的子文件夹；'' = 直接存下载根目录
    autoBack:          true,         // 详情页三连成功后自动回上一页（搜索页）
    autoBackDelayMs:   [1000, 3000], // 随机等待区间（毫秒）；想固定 1.5 秒写 [1500, 1500]
    buttonDefault:     { xPct: 96, yPct: 40 }, // 首次出现位置（视口百分比）；拖动后自动记忆
    triShotTiming:     'stagger',   // 三连时序：'stagger' 错峰（推荐）| 'parallel' 并行 | 'serial' 串行
    staggerMs:         300,         // 错峰模式下，下载比收藏晚发车的毫秒数（给收藏留出带宽头筹）
    debug:             true,         // 控制台 [DTS] 日志
  };
  /* ===================== 配置区结束 ===================== */

  const LOG = (...a) => { if (CONFIG.debug) console.log('[DTS]', ...a); };

  /* 选择器——2026-09-07 已按真实页面 fixtures 收口（实测✓） */
  const SEL = {
    csrf:          ['meta[name="csrf-token"]', 'meta[name="csrf"]'],
    detailImage:   ['div.image-show-container[data-image-id]', 'div.image-container[data-image-id]'],
    imageIdAttr:   'data-image-id',
    // 详情页有两枚下载链：首枚=带标签文件名版（站内“下载”主按钮同款），次枚=纯 ID 版
    downloadLink:  'a[href*="/img/download/"]',
    urisAttr:      'data-uris', // 网格缩略图容器上的 JSON：{"full":"…/img/view/…png",…}
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
    // 详情页以 URL 为准：/images/<id> 路径是可靠信号，query 串任意（0.1.1 修复）
    if (/\/images\/\d+/.test(location.pathname)) return 'detail';
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

  /* fixtures 实证：站内收藏按钮是 href="#" 的假链接，提交地址一律按站内路由构造；
   * 暗号按站内 form 惯例走表单参数 _csrf_token，另带 X-CSRF-Token 头双保险。 */
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
    if (!r.ok || !ct.includes('json')) {
      throw new Error(`站内返回 ${r.status}（${ct || '未知类型'}）——刷新页面重试；仍失败请用「▶️ 自检当前页面」回报`);
    }
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
    return name;
  }

  /* 下载直链优先级：详情页站内下载链（带标签文件名版）→ 网格 data-uris 的 view→download 替换
   * （fixtures 实证成立）→ JSON API representations.full 兜底。 */
  async function resolveDownload(ctx) {
    let url = ctx.downloadUrl;
    if (!url && ctx.viewUrl) url = ctx.viewUrl.replace('/img/view/', '/img/download/');
    if (!url) {
      try {
        const img = await fetchImageJson(ctx.id);
        const full = img && img.representations && img.representations.full;
        if (full) url = full.replace('/img/view/', '/img/download/');
      } catch (e) { LOG('取图片 JSON 失败：', e.message); }
    }
    if (!url) throw new Error('找不到下载直链（请用「▶️ 自检当前页面」回报）');
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

  /* 三连时序（0.1.5）：stagger=收藏先发、下载延迟跟进（默认，治 0.1.4 的带宽争抢）；
   * parallel=同时发车；serial=等收藏回包再下载。每阶段耗时记入控制台 [DTS·T]。
   * 两路各自记账（Q8 拍板：三动作独立执行独立记结果），任一失败都如实列出。 */
  async function triShot(ctx) {
    if (!ctx.id) throw new Error('找不到图片 ID');
    const t0 = performance.now();
    const marks = { 点击: 0 };
    const rec = (label) => { marks[label] = Math.round(performance.now() - t0); };
    const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const faveP = settle((async () => { rec('收藏发出'); const r = await postFave(ctx); rec('收藏回包'); return r; })());
    const dlP = settle((async () => {
      const mode = CONFIG.triShotTiming;
      if (mode === 'stagger') await wait(CONFIG.staggerMs);
      else if (mode === 'serial') await faveP;
      rec('下载发车');
      const r = await downloadImage(ctx);
      rec('下载完成');
      return r;
    })());

    const [f, d] = await Promise.all([faveP, dlP]);
    const errs = [];
    if (!f.ok) errs.push('收藏/点赞：' + f.e.message);
    if (!d.ok) errs.push('下载：' + d.e.message);
    console.log('[DTS·T] 时序=' + CONFIG.triShotTiming + ' ' + JSON.stringify(marks) + (errs.length ? ' 失败：' + errs.join('；') : ''));
    if (errs.length) throw new Error(errs.join('；') + '｜另一路已完成');
    return { inter: f.v, dl: d.v };
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
      let viewUrl = null;
      try { viewUrl = JSON.parse(state.targetEl.getAttribute(SEL.urisAttr)).full; } catch (e) { /* 走 API 兜底 */ }
      ctx = { id: state.targetId, csrf: getCsrf(), downloadUrl: null, viewUrl };
    } else {
      toast('本页不是图片页/搜索页');
      return;
    }
    setFace('busy');
    state.busy = true;
    try {
      const res = await triShot(ctx);
      setFace('ok');
      const i = res.inter || {};
      toast(`三连成功 #${ctx.id} ✓（服务器回包：收藏 ${i.faves ?? '?'}，得分 ${i.score ?? '?'}）`);
      LOG('成功：', ctx.id, res.inter, res.dl.name);
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
    const csrfEl = first(SEL.csrf);
    const dls = [...document.querySelectorAll(SEL.downloadLink)].map((a) => a.getAttribute('href'));
    const fave = document.querySelector('a.interaction--fave');
    const probeThumb = document.querySelector(SEL.thumbImage);
    let uriProbe = '';
    if (probeThumb) {
      try { uriProbe = JSON.parse(probeThumb.getAttribute(SEL.urisAttr)).full; } catch (e) { uriProbe = '✗ data-uris 解析失败'; }
    }
    const thumbs = document.querySelectorAll(SEL.thumbImage).length;
    const gms = {
      GM_download: typeof GM_download === 'function',
      GM_xmlhttpRequest: typeof GM_xmlhttpRequest === 'function',
    };
    const lines = [
      `页面类型: ${kind}（路径 ${location.pathname}）`,
      `防伪暗号(CSRF): ${csrfEl ? '✓' : '✗ 找不到'}`,
      `下载直链: ${dls.length ? '✓ ' + dls.length + ' 枚（首枚 ' + dls[0].slice(0, 46) + '…）' : '— 本页无（网格页走 data-uris）'}`,
      `收藏按钮: ${fave ? '✓ 假链接 href=' + fave.getAttribute('href') + '（提交走 /images/<id>/fave）' : '— 未找到'}`,
      `缩略图容器: ${thumbs} 个；data-uris 首枚: ${uriProbe || '—'}`,
      `GM_download: ${gms.GM_download ? '✓' : '✗（开「允许用户脚本」）'}`,
      `GM_xmlhttpRequest: ${gms.GM_xmlhttpRequest ? '✓' : '✗（开「允许用户脚本」）'}`,
      `浮动按钮已在页面: ${!!document.getElementById('dts-btn')}`,
    ];
    console.log('[DTS] 自检 ────────\n' + lines.join('\n'));
    alert('[Derpi Triple Shot 自检 0.1.2]\n\n' + lines.join('\n'));
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
    // 按钮与菜单全页常开（0.1.1）：误判页也要能跑自检，点击时会解释本页不可用
    buildButton();
    setFace('idle');
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('▶️ 自检当前页面', runSelfTest);
      GM_registerMenuCommand('🎯 重置按钮位置', () => { GM_setValue('btnPos', null); restorePos(); toast('按钮位置已重置'); });
    }
    LOG('就绪，页面类型：', pageKind());
  }

  main();
})();
