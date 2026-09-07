# fixtures — 真实页面样本

开发环境终端到不了 derpibooru，选择器靠这里的真实 HTML 验证。

## 请存这两个页面（Ctrl+S → 「网页，仅 HTML」）

1. `detail.html` — 任意一张图的详情页（点开大图后的页面）
2. `grid.html` — 一个搜索结果页（网格缩略图页）

文件名随意，`*.html` 已被 git 忽略（登录态保存的页面可能含你的用户名，不入库）。

## 存好后

```
node tests/fixture-check.mjs
```

工具会核对脚本选择器的全部假设（CSRF 标签、图片 ID 属性、下载链接、收藏链接、缩略图容器），✗ 项即需收口的选择器。
