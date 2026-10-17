# mirror · EdgeOne 全站反向代理

从 Cloudflare Workers 迁移至腾讯云 **EdgeOne Makers（Edge Functions）** 的全站反向代理项目。

保留原项目「路径式」代理语义，用户只需在域名后追加目标地址即可镜像任意站点：

```
https://<你的域名>/https://example.com/path
```

---

## 一、为什么迁移

原 Cloudflare Worker 运行在境外节点，中国大陆访问存在绕行与抖动。EdgeOne 拥有 3200+ 边缘节点且国内覆盖完善，将反代逻辑下沉到边缘函数后可显著缩短首字节时间。

迁移并非简单搬运。原实现在以下环节存在功能性缺陷，本次一并修复。

## 二、相对 Cloudflare 版的关键修复

| # | 问题 | 原实现 | 本实现 |
|---|------|--------|--------|
| 1 | 运行时入口 | `addEventListener('fetch')`，EdgeOne 不支持 | `export default function onRequest(context)` |
| 2 | 资源重写范围 | 仅重写 `href/src/action` 中**以 `/` 开头**的值 | 覆盖 `href/src/action/poster/data/cite/background/formaction/data-src/xlink:href`，并解析相对路径、协议相对路径 |
| 3 | 无引号属性 | 未处理，压缩页面（如百度首页）资源全部漏改 | 同时支持 `"..."`、`'...'`、`无引号` 三种形态 |
| 4 | CSS 内资源 | 完全未处理，`url()` / `@import` 指向代理域而 404 | 重写 `url()`、`@import`，含 `<style>` 块与行内 `style` |
| 5 | srcset | 未处理，响应式图片全部失效 | 按逗号切分逐项重写，保留 `1x/2x` 描述符 |
| 6 | 响应编码 | 未清理 `content-encoding`/`content-length`，改写 HTML 后浏览器解压失败 | 构造新响应前统一剔除 |
| 7 | 安全策略头 | 未处理，上游 CSP / X-Frame-Options 会阻断代理后的资源 | 剔除 CSP、X-Frame-Options、COEP/COOP/CORP、HSTS 等 |
| 8 | Cookie | 未处理，上游 `Domain` 导致浏览器拒写，登录态丢失 | 剥离 `Domain`，`Path` 归一为 `/`，保留多条 Set-Cookie |
| 9 | 重定向 | `new URL(location)` 遇相对地址直接抛异常 | 相对地址基于目标 URL 解析后再编码 |
| 10 | 缓存策略 | 所有响应强制 `no-store`，CDN 完全无法缓存 | HTML 强制 `no-store`；静态资源保留上游策略，缺省 `public, max-age=3600` |
| 11 | 防盗链 | 未处理，`Referer` 为代理域常被上游拦截 | 将 `Referer`/`Origin` 还原为上游真实值 |
| 12 | Range 请求 | 未显式透传 | 非 HTML/CSS 响应流式透传，支持 `206` 分段（视频拖动） |
| 13 | `<base>` 标签 | 未处理，会把相对路径重新指向代理域 | 移除 |
| 14 | SRI 完整性校验 | 未处理，改写后 `integrity` 必然校验失败 | 移除 `integrity` 属性 |
| 15 | 回环防护 | 无 | 目标地址等于代理自身时拒绝，避免无限递归 |

## 三、目录结构

```
.
├── index.html                    # 首页（静态，由 CDN 直接返回）
├── edgeone.json                  # EdgeOne 项目配置
├── edge-functions/
│   └── [[default]].js            # 全路径捕获的边缘函数（核心反代逻辑）
├── tests/
│   └── test.mjs                  # 改写逻辑单元测试（36 项）
└── cloudflare/
    └── mirror-worker.js          # 迁移前的 Cloudflare 原始实现（仅存档）
```

`edge-functions/[[default]].js` 为多级动态路由，捕获站点根下任意深度的路径。

## 四、URL 用法

三种形态均被接受，函数内自动识别：

| 形态 | 示例 | 说明 |
|------|------|------|
| raw（推荐，生成时使用） | `/https://example.com/a/b.css` | 相对路径可自然回落，兼容 Cloudflare 版旧链接 |
| 百分号编码 | `/https%3A%2F%2Fexample.com%2Fa` | 单段路径，路由安全 |
| Base64URL | `/u/aHR0cHM6Ly9leGFtcGxlLmNvbS8` | 纯 ASCII，规避特殊字符路由问题 |

首页表单生成 raw 形态。

## 五、部署

### 方式 A：绑定 GitHub 仓库（推荐）

1. 进入 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/pages) → 创建项目 → 选择本仓库。
2. 构建配置留空即可：本项目为静态资源 + 边缘函数，无需构建命令。
3. 输出目录填 `.`（仓库根目录）。
4. 部署后绑定自定义域名。

### 方式 B：本地 CLI 部署

```bash
npm i -g edgeone
edgeone login
edgeone makers deploy -n mirror
```

## 六、域名与备案（重要）

EdgeOne 的默认预览域名 `*.edgeone.cool` 在**加速区域含中国大陆**时：

- 仅提供约 **3 小时**有效期的预览链接，过期返回 `401 UNAUTHORIZED`；
- 控制台没有关闭该限制的开关，这是区域合规策略，不是配置项。

**要长期稳定访问，必须绑定一个已完成 ICP 备案的自定义域名。** 未备案域名无法获得中国大陆节点加速，迁移的收益也就无从体现。

## 七、平台限制与应对

| 限制项 | 数值 | 影响与建议 |
|--------|------|-----------|
| 请求 body | 1 MB | **影响最大**。大于 1MB 的上传会在进入函数前被拒（413）。如需代理上传类站点，应将该路径单独指向 Cloud Functions（Node.js，支持更长时长与更大体积） |
| CPU 时间 | 200 ms | 不含 I/O 等待。超大 HTML（数 MB）的正则改写可能触顶，建议对超大文档关闭改写 |
| 运行内存 | 128 MB | 流式透传不落内存，大文件不受影响；HTML/CSS 需完整读入后改写 |
| 代码包 | 5 MB | 当前实现约 20 KB，余量充足 |
| 响应体 | 无明确上限 | 非文本资源走 `ReadableStream` 透传，支持视频拖动 |
| 循环次数 | 100000 次 | 正则替换不受限，手写循环需注意 |

## 八、已知限制

1. **JavaScript 内的硬编码根路径**：前端 JS 中以字符串形式写死的 `/api/...` 不会进入代理，会命中代理域根路径。这是无状态路径代理的固有局限。规避方式为目标站点本身使用相对路径，或为其单独配置前缀映射。
2. **依赖 `window.location` 绝对路径判断的 SPA**：路由库若读取 `location.pathname` 做匹配，会看到 `/https://...` 前缀，可能路由异常。
3. **WebSocket**：边缘函数当前不支持，实时类站点无法完整代理。
4. **平台注入**：Makers 会向 HTML 响应注入 `unified.js`（预览域名鉴权脚本），自定义域名下通常不再注入。

## 九、测试

```bash
node tests/test.mjs
```

覆盖 URL 归一化、三种路径形态解析、HTML/CSS 重写（含无引号属性、srcset、data URI 保留）、Set-Cookie 拆分等 36 项断言。

## 十、许可

仅供个人学习与自用。
