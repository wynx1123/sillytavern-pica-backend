# Pica Tavern Relay（增强分支）

酒馆（SillyTavern）的哔咔中继后端。本分支在原版基础上做了两件事：

1. **本地磁盘缓存**：图片与 GET 接口响应缓存在酒馆机器上，命中后不再访问上游；面板可查看命中率、调整上限、一键清空。
2. **修复阅读器「看三页就要收起再打开」 + 新增捏合放大**：重新打包 `/dist` 下的阅读器前端（`1.0.3`），解决自动续载/图片预取停住的问题，加入阅读器内存图片缓存，并支持**双指捏合放大（最高 5 倍）/ 双击 2.5 倍 / 放大后单指拖动**——小字漫画终于能放大看了。

> 前端本体不在本仓库：它由作者以签名包形式发布在 R2。`dist/` 里的修复版是用 `tools/` 下的脚本对官方 `1.0.1` 打补丁后重建的，可复现。

## 安装 / 升级后端

```bash
git clone https://github.com/ssrf8/sillytavern-pica-backend.git
# 放进 SillyTavern 的 plugins 目录，然后：
node plugins/sillytavern-pica-backend/install.mjs
```

重启酒馆后，在「扩展程序 → 哔咔后端」里能看到 **缓存** 区块。

### 缓存配置

面板里可以直接启用/停用、查看占用与命中率、清空。也可以写 `cache.local.json`（与 `index.mjs` 同目录，已在 `.gitignore`）：

```json
{
  "enabled": true,
  "maxBytes": 536870912,
  "imageTtlDays": 7,
  "apiTtlSeconds": 180
}
```

环境变量优先级更高：

| 变量 | 作用 |
|---|---|
| `PICA_CACHE=0/1` | 强制关闭/开启 |
| `PICA_CACHE_MAX_MB=1024` | 缓存上限（8 MB – 8 GB） |
| `PICA_CACHE_DIR=/path` | 换缓存目录（默认 `./cache/relay/`） |

缓存策略：

- **图片**：按上游 URL 缓存，默认 7 天；流式转发的同时写盘，不额外增加首屏等待。
- **接口**：只缓存 GET 白名单（分类/关键词/合集/列表/详情/章节/页码/推荐），按 **账号 token 的哈希** 与 `image-quality`、`app-channel` 分桶；`users/*`、`comments/*`、`comics/random` 永不缓存。
- 响应头 `X-Pica-Cache: hit|miss|bypass|off` 可用于排查。
- 管理接口（需酒馆管理员）：`GET /api/plugins/pica-relay/cache/status`、`POST /cache/config`、`POST /cache/clear`。

## 修复阅读器「三页」问题

### 根因（实测复现）

用本地假中转把官方阅读器跑起来后确认：不是后端分页坏了，而是前端三处叠加：

1. 图片预取窗口写死 `600px`，长条漫画一页就有 1–2 屏高，所以永远只预取到下一张左右；
2. 图片是否加载**只依赖 IntersectionObserver**，回调漏一次（阴影 DOM、快速滑动、被遮挡）就永远排队；
3. 自动续载 `progress()` 只在 `requestAnimationFrame` 里跑；rAF 被节流/暂停时（后台标签、长帧、部分 WebView）续载就停了；收起再打开会显式触发一次 `resume()`，于是又能看三页。

### 修复内容（`tools/patch-reader.mjs`）

- 预取窗口从 600px 改为约 **2 屏**，并按几何位置兜底判定，不再只信 IntersectionObserver；
- 滚动时主动刷新加载队列；
- 自动续载加 **300ms setTimeout 看门狗**，rAF 不跑也能继续；
- 跳页锚点改为「布局稳定后释放」，用户真正滚动超过 80px 就不再回拉；
- 阅读页 `loading="eager"`（何时设 `src` 由加载器控制）；
- 新增 **32 MB 内存 LRU**，翻回去/重开章节不再重新下载。

### 安装修复版

```bash
# 1. 拉官方包并校验哈希
node tools/fetch-official-reader.mjs --out .official

# 2. 打补丁
node tools/patch-reader.mjs \
  --input .official/releases/1.0.1/app.mjs \
  --out dist/app.mjs --version 1.0.4

# 3. 生成可导入的酒馆脚本 + 自定义更新源目录
node tools/build-reader-release.mjs \
  --script .official/releases/1.0.1/script.json \
  --app dist/app.mjs --out dist --version 1.0.4
```

产物：

- `dist/pica-reader-fixed-1.0.4.json` — 在 **酒馆助手 → 脚本库 → 导入** 即可。导入前请先停用/删除原版哔咔脚本（助手里同时存在两份会拒绝安装）。
- 修复版使用独立的更新库（`tw.pica.reader.updates.v1.fix`），不会被旧版 IndexedDB 里缓存的官方前端顶掉；账号、线路、阅读记录仍共用原来的 localStorage。
- `dist/release/` — 可选的自建更新源：把该目录放到任意 HTTPS 根地址，在阅读器「设置 → 程序更新 → 更新源」填入即可。修复版默认 **关闭官方自动更新**，避免被官方 `1.0.1` 覆盖。

回滚：停用修复版脚本、重新启用原版即可；后端缓存可在面板一键清空。

## 测试

```bash
node --test test/*.test.mjs
```

覆盖：LRU/过期/淘汰/持久化、API 缓存分桶与 POST 不缓存、图片流式写缓存、非 200 不缓存、管理路由鉴权与配置校验。

## 版本

- 后端插件：`1.1.0`（`core.mjs` 协议版本 `0.5.0`）
- 阅读器修复版：`1.0.4`（官方基线 `1.0.1`；`1.0.3` 新增**双指捏合放大 / 双击 2.5 倍 / 放大后单指拖动**）
