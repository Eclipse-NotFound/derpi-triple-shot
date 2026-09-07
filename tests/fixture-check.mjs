#!/usr/bin/env node
/**
 * fixture-check — 用 fixtures 里的真实页面 HTML 核对脚本选择器假设。
 * 用法：node tests/fixture-check.mjs
 * 零依赖；✗ 的项 = 需要收口的选择器（对照 derpi-triple-shot.user.js 里的 SEL）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const files = readdirSync(root).filter((f) => f.toLowerCase().endsWith('.html'));
if (files.length === 0) {
  console.log('fixtures 目录还没有 .html 文件——按 fixtures/README.md 存两个页面后再跑。');
  process.exit(0);
}

const CHECKS = [
  { name: 'CSRF meta（候选 meta[name="csrf-token"]）', re: /name=["']csrf-token["'][^>]*content=["']([^"']{10,})/i, critical: true },
  { name: 'CSRF meta 备选写法（meta[name="csrf"]）', re: /name=["']csrf["']/i, critical: false },
  { name: '图片容器 data-image-id', re: /data-image-id=["'](\d+)["']/i, critical: true },
  { name: '标签属性 data-image-tags', re: /data-image-tags=["']/i, critical: false },
  { name: '下载直链 /img/download/', re: /href=["'][^"']*\/img\/download\//i, critical: false },
  { name: '图片直链 /img/view/', re: /href=["'][^"']*\/img\/view\//i, critical: false },
  { name: '收藏链接 a.interaction--fave', re: /<a[^>]+class=["'][^"']*interaction--fave/i, critical: false },
  { name: '收藏链接带 data-method', re: /interaction--fave[^>]*data-method=["'](post|delete)["']/i, critical: false },
  { name: '缩略图容器 media-box', re: /class=["'][^"']*media-box/i, critical: false },
  { name: '网格容器 imagelist/image-grid', re: /class=["'][^"']*(imagelist|image-grid)/i, critical: false },
];

let failures = 0;

for (const file of files) {
  const html = readFileSync(join(root, file), 'utf8');
  console.log(`\n━━━ ${file}（${(html.length / 1024).toFixed(0)} KB）━━━`);
  for (const c of CHECKS) {
    const m = html.match(c.re);
    const ok = !!m;
    if (!ok && c.critical) failures++;
    const detail = m && m[1] ? `  例：${m[1].slice(0, 40)}…` : '';
    console.log(`${ok ? '✓' : (c.critical ? '✗' : '－')} ${c.name}${detail}`);
  }
  // 帮助收口：列出页面里实际出现的图片交互相关 class 片段
  const classes = [...html.matchAll(/class=["']([^"']*(?:interaction|media-box|image-container)[^"']*)["']/g)]
    .map((m) => m[1]);
  const uniq = [...new Set(classes)].slice(0, 12);
  if (uniq.length) console.log('  页面实际 class 样本：\n   - ' + uniq.join('\n   - '));
}

console.log(failures === 0 ? '\n全部关键项通过 ✓' : `\n${failures} 个关键项未命中 ✗ —— 需要收口选择器`);
process.exit(failures === 0 ? 0 : 1);
