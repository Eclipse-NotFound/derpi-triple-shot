// ==UserScript==
// @name         Derpi Triple Shot — derpibooru 一键三连
// @namespace    local.derpi.triple.shot
// @version      0.2.5
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
 * 里程碑备注（0.2.5 = E 键翻页（用户需求：从前一页切到后一页；沿用站内 a.js-next，fixtures 已实证
 *              62→63→64 结构）；另提醒：菜单缺「清空活动日志」= 装的是 ≤0.2.3，0.2.4 双下载修复未生效）：
 * 里程碑备注（0.2.4 = 双下载隐患修复：文件名限长 150（带标签版可达 220+ 字符，路径超长触发
 *              子目录失败→平铺重试，制造双下载）；dispatchDownload 改单次尝试不自动重试；
 *              活动日志 40→250 条 + 「🧹 清空活动日志」菜单，供复现取证）：
 * 里程碑备注（0.2.3 = 全手势活动日志（GM 存储环形 40 条，菜单「📋 活动日志」可读）+ 键盘改捕获期监听 +
 *              网格 D 现场锁定兜底；目标：用数据揪出"详情页左键仍触发下载"与"网格 D 无反应"两症）：
 * 里程碑备注（0.2.2 = 左键返回竞态修复：返回前 backNow 先锁按钮+作废在途流程，30ms 后离场；
 *             pageshow 钩子清掉 BFCache 恢复页残留的锁定目标，杜绝返回瞬间合成点击"补刀"下载）：
 * 里程碑备注（0.2.1 = D 键导航环（网格→详情→返回）+ 自动返回延时菜单可调（存脚本存储，立即生效））：
 *  0.2.0 键盘三连：F 键纯搭载——收藏+点赞走站内原生处理器（星星实时点亮），
 *              插件对同一次按键只补发下载（详情页再加自动返回）；网格/详情通用，⚡ 按钮退役为鼠标备用。
 *              护栏：输入框/编辑器焦点、Ctrl/Alt/Meta/Shift 修饰键、按键连发(e.repeat)一律不触发；未登录拒发并提示。
 *  0.1.9 手势重排：详情页左键=直接返回、右键=三连；网格左键=三连。
 *  0.1.7 dispatch 发出即走：收藏+下载请求发车即返回，不等任何回包；
 *  - 已知代价（用户拍板接受的）：返回会把页面冻进缓存，收藏结果无人回读——失败静默。
 *  - 对策：发出前预检登录态（页头有退出登录链接=已登录）；未登录直接拒发并红字提示。
 *  - 下载走 chrome.downloads（浏览器进程），页面冻结不影响传输，发出即安全。
 *  - 想退回"等收藏回包再走"：triShotTiming 改回 'stagger' 一行字。
 *  （0.1.6 时序存档+动态版本标题；0.1.5 三时序开关+时间戳；0.1.4 并行；0.1.2 fixtures 收口修 403：
 *    收藏按钮是 href="#" 假链接，一律 POST /images/<id>/fave + 表单参数 _csrf_token + 头双保险；
 *    下载直链=详情页 a[href*="/img/download/"] 首枚 / 网格 data-uris 的 view→download 替换。）
 */

(function () {
  'use strict';

  /* ===================== 配置区（改这里即可） ===================== */
  const CONFIG = {
    downloadSubfolder: 'derpi',      // 存到浏览器默认下载目录下的子文件夹；'' = 直接存下载根目录
    autoBack:          true,         // 详情页三连成功后自动回上一页（搜索页）
    autoBackDelayMs:   [300, 600],  // 返回前停顿（dispatch 模式回包不等，这段纯为让你瞄一眼提示）；真·秒回写 [0, 0]
    buttonDefault:     { xPct: 96, yPct: 40 }, // 首次出现位置（视口百分比）；拖动后自动记忆
    triShotTiming:     'dispatch',  // 三连时序：'dispatch' 发出即走（默认，激进）| 'stagger' 错峰 | 'parallel' 并行 | 'serial' 串行
    hotkey:            'f',         // 0.2.0 键盘三连：站内原生收藏/点赞 + 插件补下载（详情页附自动返回）；撞了就改这一个字
    navHotkey:         'd',         // 0.2.1 导航键：网格按 D=进当前悬停图的详情页；详情页按 D=返回上一页
    pageHotkey:        'e',         // 0.2.5 翻页键：搜索/标签页按 E=翻到下一页（走站内 Next 链接）
    staggerMs:         300,         // 下载比收藏晚发车的毫秒数（dispatch/stagger 通用：给收藏留出带宽头筹）
    debug:             true,         // 控制台 [DTS] 日志
  };
  /* ===================== 配置区结束 ===================== */

  const LOG = (...a) => { if (CONFIG.debug) console.log('[DTS]', ...a); };

  /* 0.2.3 活动日志：环形 250 条、每条落 GM 存储（跨页面保留）；菜单「📋 活动日志」读出 */
  const journal = [];
  function J(msg) {
    const line = new Date().toTimeString().slice(0, 8) + ' ' + msg;
    journal.push(line);
    if (journal.length > 250) journal.shift();
    if (typeof GM_setValue === 'function') GM_setValue('journal', journal.join('\n'));
    if (CONFIG.debug) console.log('[DTS·J]', msg);
  }
  function showJournal() {
    const data = (typeof GM_getValue === 'function') ? GM_getValue('journal', '') : '';
    alert('[活动日志（最近 250 条）]\n\n' + (data || '（空——请先复现一次问题）'));
  }
  function clearJournal() {
    journal.length = 0;
    if (typeof GM_setValue === 'function') GM_setValue('journal', '');
    toast('活动日志已清空');
  }

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
    token: 0,         // 0.2.2 竞态护栏：每次「先停手再返回」+1，在途流程回写状态前核对，作废即弃
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
    // 0.2.4：截断超长文件名（带标签版可达 220+ 字符），避免路径超长触发“失败→重试”的双下载
    if (name.length > 150) {
      const m = name.match(/\.\w{2,5}$/);
      name = name.slice(0, 150 - (m ? m[0].length : 0)) + (m ? m[0] : '');
    }
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

  /* dispatch 模式专用：下载入队即算数——chrome.downloads 在浏览器进程传输，
   * 页面冻结死不掉的；但 URL 解析必须先完成（罕见兜底路径可能多花一二百毫秒）。 */
  async function dispatchDownload(ctx) {
    if (typeof GM_download !== 'function') throw new Error('GM_download 不可用——检查「允许用户脚本」开关');
    const { url, name } = await resolveDownload(ctx);
    const target = (CONFIG.downloadSubfolder ? CONFIG.downloadSubfolder + '/' : '') + name;
    J('下载发车 #' + ctx.id + ' → ' + target.slice(0, 48));
    // 0.2.4：单次尝试，不再自动重试（重试=双下载）；文件名已在上游限长
    gmDownload(url, target).catch((e) => { J('下载失败（不重试）：' + e.message); });
    return { name: target };
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

  /* 三连时序：dispatch=发出即走（默认，用户拍板的激进模式）；stagger=错峰（收藏先发车）；
   * parallel=同时发车等两路结果；serial=串行等结果。dispatch 的代价：页面返回即冻结，
   * 收藏回包无人读——失败静默，用发出前登录预检堵住最大的坑。 */
  async function triShot(ctx) {
    if (!ctx.id) throw new Error('找不到图片 ID');
    const mode = CONFIG.triShotTiming;
    const t0 = performance.now();
    const marks = { 点击: 0 };
    const rec = (label) => { marks[label] = Math.round(performance.now() - t0); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

    if (mode === 'dispatch') {
      if (!document.querySelector('a[href="/sessions"][data-method="delete"]')) {
        throw new Error('未登录——dispatch 模式无法事后报告，已拒绝发出（请先登录，或把 triShotTiming 改回 stagger）');
      }
      postFave(ctx).catch((e) => LOG('收藏结果（页面冻结后不可见）：', e.message)); // 发出即结案
      rec('收藏发出');
      await wait(CONFIG.staggerMs); // 给收藏请求留出带宽头筹（staggerMs 同样作用于 dispatch）
      let dl;
      try { dl = await dispatchDownload(ctx); } catch (e) { throw new Error('下载未发出：' + e.message); }
      rec('下载发车');
      const line = `时序=dispatch #${ctx.id} ${JSON.stringify(marks)}（回包不回读）`;
      console.log('[DTS·T] ' + line);
      if (typeof GM_setValue === 'function') GM_setValue('lastTiming', line);
      return { inter: null, dl, dispatched: true };
    }

    const faveP = settle((async () => { rec('收藏发出'); const r = await postFave(ctx); rec('收藏回包'); return r; })());
    const dlP = settle((async () => {
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
    const timing = `时序=${CONFIG.triShotTiming} #${ctx.id} ${JSON.stringify(marks)}` +
      (errs.length ? ' 失败：' + errs.join('；') : '');
    console.log('[DTS·T] ' + timing);
    if (typeof GM_setValue === 'function') GM_setValue('lastTiming', timing); // 自动返回会清控制台，存档留证
    if (errs.length) throw new Error(errs.join('；') + '｜另一路已完成');
    return { inter: f.v, dl: d.v };
  }

  /* 自动返回统一入口在浮动按钮区（backNow/scheduleAutoBack，0.2.2 带竞态护栏），此处旧版已除 */

  /* ---------------- 浮动按钮 UI ---------------- */

  let btn, face, resetTimer = null;

  function buildButton() {
    btn = document.createElement('div');
    btn.id = 'dts-btn';
    face = document.createElement('div');
    face.className = 'dts-face';
    face.textContent = '⚡';
    btn.appendChild(face);
    btn.title = '详情页：左键=返回 · 右键=三连｜网格页：左键=三连锁定图（可拖动）';
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
      if (down && dragged) { GM_setValue('btnPos', { x: btn.offsetLeft, y: btn.offsetTop }); J('按钮拖动并松手'); }
      else if (down && e.button === 0) { J('按钮左键点起'); onLeftClick(); }   // 右键走 contextmenu，不在这里触发
      down = null;
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();                                  // 按钮上压掉浏览器右键菜单
      J('按钮右键（→三连）');
      if (pageKind() === 'detail') onClickButton();        // 详情页右键 = 三连（0.1.9 手势）
    });
  }

  /* 0.1.9 手势（用户拍板）：详情页左键=直接返回、右键=三连；网格左键=三连锁定目标 */
  function onLeftClick() {
    if (state.busy) return;
    if (pageKind() === 'detail') { goBackNow(); return; }
    onClickButton();
  }

  /* 0.2.2 竞态修复：返回前先停手——作废一切在途流程、按钮上锁，30ms 后再走。
   * 病灶：返回瞬间详情页冻结进缓存，半路的下载流程回调在解冻边界继续执行，
   * 造成“左键返回顺带触发下载”。 */
  function backNow(quiet) {
    J('backNow（quiet=' + quiet + '）');
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
      J('backNow 30ms 后离场');
      if (history.length > 1) history.back();
      else window.close();
    }, 30);
  }

  function goBackNow() { backNow(false); }

  function scheduleAutoBack() {
    if (!CONFIG.autoBack) return;
    const ref = document.referrer || '';
    if (!ref.includes(location.hostname)) { toast('已完成（无站内来路，不自动返回）'); return; }
    // 0.2.1：菜单设置的固定延时优先（存脚本存储，跨更新保留）；未设置则用配置区默认区间随机
    const fixed = (typeof GM_getValue === 'function') ? GM_getValue('backDelayMs', null) : null;
    const [a, b] = (typeof fixed === 'number' && Number.isFinite(fixed)) ? [fixed, fixed] : CONFIG.autoBackDelayMs;
    const delay = Math.round(a + Math.random() * Math.max(0, b - a));
    const token = state.token;
    J('排定自动返回 ' + delay + 'ms（token=' + token + '）');
    setTimeout(() => { if (token === state.token) backNow(true); }, delay);
  }

  async function onClickButton() {
    if (state.busy) return;
    const kind = pageKind();
    J('按钮三连 kind=' + kind + ' target=' + (state.targetId || '∅'));
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
        LOG('已发出：', ctx.id, res.dl.name);
      } else {
        const i = res.inter || {};
        toast(`三连成功 #${ctx.id} ✓（服务器回包：收藏 ${i.faves ?? '?'}，得分 ${i.score ?? '?'}）`);
        LOG('成功：', ctx.id, res.inter, res.dl.name);
      }
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

  function setTargetFromEl(c) {
    if (!c || c === state.targetEl) return;
    if (state.targetEl) state.targetEl.classList.remove('dts-target');
    state.targetEl = c;
    state.targetId = c.getAttribute(SEL.imageIdAttr);
    c.classList.add('dts-target');
    if (face) face.textContent = '⚡';
    J('锁定目标 #' + state.targetId);
  }

  document.addEventListener('mouseover', (e) => {
    if (pageKind() !== 'grid' || !e.target || !e.target.closest) return;
    setTargetFromEl(e.target.closest('div.image-container[data-image-id]'));
  });

  /* 0.2.2 BFCache 恢复清理：返回进缓存的页面再解冻时，清掉冻结前残留的锁定目标与忙态——
   * 否则返回瞬间浏览器合成的第二次点击会落在旧目标上，造成"左键返回顺带下载"。 */
  window.addEventListener('pageshow', (e) => {
    J('pageshow persisted=' + e.persisted);
    if (!e.persisted) return;                 // 只处理从缓存恢复（back/forward 解冻），首次加载不清理
    state.targetEl = null;
    state.targetId = null;
    state.busy = false;
    state.token++;
    if (btn) setFace('idle');
    LOG('BFCache 恢复，已清理残留目标/忙态');
  });

  /* ---------------- 0.2.0 键盘三连：F=站内原生收藏/点赞，本插件对同一按键补发下载（详情页附返回） ---------------- */

  function isTextTarget(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function gridContext() {
    let viewUrl = null;
    try { viewUrl = JSON.parse(state.targetEl.getAttribute(SEL.urisAttr)).full; } catch (e) { /* 走 API 兜底 */ }
    return { id: state.targetId, csrf: getCsrf(), downloadUrl: null, viewUrl };
  }

  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const key = (e.key || '').toLowerCase();
    const isF = key === CONFIG.hotkey;
    const isD = key === CONFIG.navHotkey;
    const isE = key === CONFIG.pageHotkey;
    if (!isF && !isD && !isE) return;
    if (isTextTarget(e.target)) return;                        // 搜索框/标签编辑器里打字永不触发
    const kind = pageKind();
    if (kind === 'grid' && !state.targetId) {
      // 悬停追踪万一滞后：按键事件目标本身在缩略图上则现场锁定（0.2.3 兜底）
      const c = e.target.closest && e.target.closest('div.image-container[data-image-id]');
      if (c) setTargetFromEl(c);
    }
    J(`key ${key.toUpperCase()} kind=${kind} target=${state.targetId || '∅'}`);
    if (isE) {
      if (kind === 'grid') gotoRelPage(+1);                     // 搜索/标签页：翻到下一页
      else J('E 仅作用于搜索/网格页');
    } else if (isF) {
      if (kind === 'detail') runHotkey(detailContext(), true);   // 详情页：补下载 + 自动返回
      else if (kind === 'grid' && state.targetId) runHotkey(gridContext(), false); // 网格：补下载（收藏交给站方自己的 F）
      else J('F 无目标，只余站方原生收藏');
    } else {
      if (kind === 'detail') goBackNow();                        // 详情页 D：直接返回上一页
      else if (kind === 'grid' && state.targetId) openTarget();  // 网格 D：当前标签页进入悬停图的详情页
      else J('D 未命中（非详情页或无目标）');
    }
  }, true);  // 捕获期：先于站方快捷键处理器，杜绝被抢听/停传播吞掉

  /* 网格 D：优先用缩略图自己的链接（保留 ?q= 浏览上下文），退化纯 ID */
  function openTarget() {
    const a = state.targetEl && state.targetEl.querySelector('a[href^="/images/"]');
    location.assign(a ? a.getAttribute('href') : '/images/' + state.targetId);
    LOG('D 进入详情 #' + state.targetId);
  }

  /* E 键：搜索/标签页翻到下一页（0.2.5；沿用站内 a.js-next，js-prev 预留） */
  function gotoRelPage(dir) {
    const a = dir > 0 ? document.querySelector('a.js-next') : document.querySelector('a.js-prev');
    if (!a) { toast(dir > 0 ? '已是最后一页' : '已是第一页'); return; }
    J('E 翻页 → ' + a.getAttribute('href').slice(0, 70));
    location.assign(a.getAttribute('href'));
  }

  async function runHotkey(ctx, withBack) {
    if (state.busy || !ctx.id) return;
    if (!document.querySelector('a[href="/sessions"][data-method="delete"]')) {
      toast('未登录——站内原生 F 收藏不会生效，下载已跳过');
      return;
    }
    J('F 流程开始 #' + ctx.id + ' withBack=' + withBack);
    state.busy = true;
    setFace('busy');
    try {
      await dispatchDownload(ctx);   // 入队即结案；下载由浏览器进程完成，页面返回冻结不影响
      setFace('ok');
      toast(`三连已发出 #${ctx.id} ✓（收藏=站内原生，下载已入队）`);
      const line = `时序=hotkey #${ctx.id} 下载入队（收藏/点赞=站内F原生）`;
      console.log('[DTS·T] ' + line);
      if (typeof GM_setValue === 'function') GM_setValue('lastTiming', line);
      if (withBack) scheduleAutoBack();
    } catch (e) {
      J('F 流程失败：' + e.message);
      setFace('fail');
      toast('快捷键三连失败：' + e.message);
      LOG('hotkey:', e);
    } finally {
      state.busy = false;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => setFace('idle'), 2500);
    }
  }

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
      `最近一次三连时序: ${typeof GM_getValue === 'function' ? (GM_getValue('lastTiming', '（从未跑过）')) : '—'}`,
    ];
    console.log('[DTS] 自检 ────────\n' + lines.join('\n'));
    const ver = (typeof GM_info === 'object' && GM_info.script) ? GM_info.script.version : '?';
    alert('[Derpi Triple Shot 自检 v' + ver + ']\n\n' + lines.join('\n'));
  }

  /* 0.2.1 延时设置菜单项：输入即存（毫秒），留空恢复默认随机区间；无需改代码、无需重装 */
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
      console.warn('[DTS] GM 功能不可用——大概率是 Chrome 的「允许用户脚本」没开（见 README 排障第 1 条）。');
    }
    // 按钮与菜单全页常开（0.1.1）：误判页也要能跑自检，点击时会解释本页不可用
    buildButton();
    setFace('idle');
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('▶️ 自检当前页面', runSelfTest);
      GM_registerMenuCommand('⏱ 设置自动返回延时', setBackDelayMenu);
      GM_registerMenuCommand('📋 活动日志', showJournal);
      GM_registerMenuCommand('🧹 清空活动日志', clearJournal);
      GM_registerMenuCommand('🎯 重置按钮位置', () => { GM_setValue('btnPos', null); restorePos(); toast('按钮位置已重置'); });
    }
    LOG('就绪，页面类型：', pageKind());
  }

  main();
})();
