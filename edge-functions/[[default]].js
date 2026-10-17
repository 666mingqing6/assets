/**
 * EdgeOne Makers / Edge Functions —— 全站反向代理
 *
 * 迁移自 Cloudflare Worker `mirror`（Service Worker 语法）。
 * 主要差异：
 *   1. Edge Functions 不支持 addEventListener，改为 export default onRequest(context)
 *   2. 原版仅重写 HTML 中「以 / 开头」的属性，导致 CSS、srcset、相对路径、CSS 内 url() 全部失效
 *   3. 原版未清理 content-encoding / content-length，改写 HTML 后浏览器会解压失败
 *   4. 原版对所有响应强制 no-store，CDN 无法缓存静态资源，中国大陆加速收益被抵消
 *
 * URL 形态（两种都接受，生成时用 raw）：
 *   raw  : /https://example.com/a/b.css     —— 相对路径可自然回落到 /https://example.com/a/xxx
 *   b64  : /u/aHR0cHM6Ly9leGFtcGxlLmNvbS8   —— 单段纯 ASCII，路由绝对安全
 */

const REDIRECT_CODES = [301, 302, 303, 307, 308];

// 需要从上游响应中剔除的头部：要么会破坏改写后的响应，要么会阻断被代理站点的资源加载
const STRIP_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel',
];

// 需要从上游请求中剔除的头部：逐跳头 + 各平台注入的私有头
const STRIP_REQUEST_HEADERS = [
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'cdn-loop',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cf-ew-via',
  'cf-polished',
];

// onRequest 覆盖 GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS 全部方法
export default function onRequest(context) {
  return handle(context.request);
}

async function handle(request) {
  const reqUrl = new URL(request.url);

  // 根路径正常情况下由静态 index.html 命中；此处仅作兜底
  if (reqUrl.pathname === '/' || reqUrl.pathname === '') {
    return new Response(ROOT_FALLBACK_HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // CORS 预检直接短路，避免把预检打到上游
  if (request.method === 'OPTIONS' && request.headers.get('access-control-request-method')) {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let target;
  try {
    target = parseTarget(reqUrl);
  } catch (err) {
    return errorResponse(400, '目标地址解析失败：' + err.message);
  }

  if (!target) {
    return errorResponse(
      400,
      '无法识别目标地址。用法：' +
        reqUrl.origin +
        '/https://example.com/path 或 ' +
        reqUrl.origin +
        '/u/<base64url>'
    );
  }

  if (target.host === reqUrl.host) {
    return errorResponse(400, '目标地址与代理自身相同，已拒绝以避免回环。');
  }

  let upstream;
  try {
    upstream = await fetch(buildUpstreamRequest(request, target));
  } catch (err) {
    return errorResponse(502, '上游请求失败：' + (err && err.message ? err.message : String(err)));
  }

  try {
    return await buildDownstreamResponse(request, upstream, target);
  } catch (err) {
    return errorResponse(502, '响应处理失败：' + (err && err.message ? err.message : String(err)));
  }
}

/* ------------------------------------------------------------------ */
/* 目标地址解析                                                        */
/* ------------------------------------------------------------------ */

function parseTarget(reqUrl) {
  const raw = reqUrl.pathname.slice(1);
  if (!raw) return null;

  // /u/<base64url> 形态
  if (raw.startsWith('u/')) {
    const decoded = b64urlDecode(raw.slice(2));
    return decoded ? normalizeUrl(decoded, reqUrl.search) : null;
  }

  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // 非法百分号编码时保留原文，交给后续逻辑判断
  }
  return normalizeUrl(path, reqUrl.search);
}

function normalizeUrl(input, search) {
  let s = String(input).trim();
  if (!s) return null;

  // CDN 可能把 // 折叠成 /，这里补回
  if (/^https?:\/[^/]/i.test(s)) {
    s = s.replace(/^(https?):\/(?!\/)/i, '$1://');
  }
  // 显式声明了非 http(s) 协议的直接拒绝，避免被误加前缀
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) {
    return null;
  }
  if (!/^https?:\/\//i.test(s)) {
    s = 'https://' + s;
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  // 路径里的查询串被 CDN 当作本域 query 时，补回目标 URL
  if (!url.search && search) url.search = search;
  return url;
}

function b64urlDecode(s) {
  try {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
  } catch {
    return null;
  }
}

function toProxyUrl(absoluteUrl) {
  return '/' + encodeURI(absoluteUrl);
}

/* ------------------------------------------------------------------ */
/* 上游请求                                                            */
/* ------------------------------------------------------------------ */

function buildUpstreamRequest(request, target) {
  const headers = new Headers(request.headers);

  for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
  // 平台私有头统一剔除（EdgeOne 会注入 eo-* 系列）
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith('eo-')) headers.delete(name);
  }

  // 把代理域上的 Referer / Origin 还原成上游真实值，规避防盗链与来源校验
  const referer = request.headers.get('referer');
  if (referer) {
    const real = unproxyUrl(referer, target);
    if (real) headers.set('referer', real);
  }
  const origin = request.headers.get('origin');
  if (origin) {
    const real = unproxyUrl(origin, target);
    headers.set('origin', real || target.origin);
  }

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }

  return new Request(target.toString(), init);
}

function unproxyUrl(value, target) {
  try {
    const u = new URL(value);
    const raw = u.pathname.slice(1);
    const decoded = raw.startsWith('u/') ? b64urlDecode(raw.slice(2)) : decodeURIComponent(raw);
    if (decoded && /^https?:\/\//i.test(decoded)) return decoded + u.search;
  } catch {
    /* ignore */
  }
  return target.origin;
}

/* ------------------------------------------------------------------ */
/* 下游响应                                                            */
/* ------------------------------------------------------------------ */

async function buildDownstreamResponse(request, upstream, target) {
  const headers = new Headers(upstream.headers);
  for (const name of STRIP_RESPONSE_HEADERS) headers.delete(name);

  rewriteSetCookie(headers, upstream.headers);

  if (REDIRECT_CODES.includes(upstream.status)) {
    const location = upstream.headers.get('location');
    if (location) {
      let abs = location;
      try {
        abs = new URL(location, target).toString();
      } catch {
        /* 保留原值 */
      }
      headers.set('location', toProxyUrl(abs));
    }
    return new Response(null, { status: upstream.status, headers });
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();

  // HTML：重写资源引用
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const charset = extractCharset(contentType) || 'utf-8';
    const text = decodeBody(await upstream.arrayBuffer(), charset);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');
    applyCors(headers, request);
    return new Response(rewriteHtml(text, target), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // CSS：重写 url() 与 @import，否则样式表里的图片/字体全部 404
  if (contentType.includes('text/css')) {
    const charset = extractCharset(contentType) || 'utf-8';
    const text = decodeBody(await upstream.arrayBuffer(), charset);
    headers.set('content-type', 'text/css; charset=utf-8');
    applyCors(headers, request);
    return new Response(rewriteCss(text, target), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // 其余（图片/字体/视频/JSON/JS）：流式透传，不落内存，支持 Range 分段
  applyCors(headers, request);
  applyCachePolicy(headers, upstream.status);

  if (request.method === 'HEAD' || upstream.status === 204 || upstream.status === 205 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function rewriteSetCookie(headers, upstreamHeaders) {
  let cookies = [];
  if (typeof upstreamHeaders.getSetCookie === 'function') {
    cookies = upstreamHeaders.getSetCookie();
  } else {
    const raw = upstreamHeaders.get('set-cookie');
    if (raw) cookies = splitSetCookie(raw);
  }
  if (!cookies.length) return;

  headers.delete('set-cookie');
  for (const cookie of cookies) {
    // 去掉 Domain（否则浏览器会拒绝写入代理域），Path 归一为 /（否则子路径下 Cookie 不生效）
    let c = cookie
      .replace(/;\s*domain=[^;]*/gi, '')
      .replace(/;\s*path=[^;]*/gi, '')
      .replace(/;\s*partitioned/gi, '');
    c = c.replace(/;\s*$/, '') + '; Path=/';
    headers.append('set-cookie', c);
  }
}

function splitSetCookie(raw) {
  const out = [];
  let start = 0;
  // 以 ", name=" 作为分隔，避开 Expires 中的逗号
  const re = /,\s*(?=[^;=,\s]+=)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push(raw.slice(start, m.index).trim());
    start = m.index + 1;
  }
  out.push(raw.slice(start).trim());
  return out.filter(Boolean);
}

function applyCachePolicy(headers, status) {
  if (status !== 200 && status !== 203 && status !== 206) return;
  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'public, max-age=3600');
  }
}

function applyCors(headers, request) {
  if (!request.headers.get('origin')) return; // 同源访问无需 CORS
  if (!headers.has('access-control-allow-origin')) {
    for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  }
  if (headers.get('access-control-allow-origin') === '*') {
    headers.delete('access-control-allow-credentials');
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '86400',
  };
}

/* ------------------------------------------------------------------ */
/* 内容重写                                                            */
/* ------------------------------------------------------------------ */

const REWRITABLE_ATTRS = [
  'href',
  'src',
  'action',
  'poster',
  'data',
  'cite',
  'background',
  'formaction',
  'data-src',
  'data-href',
  'data-original',
  'xlink:href',
];

// 三种属性值形态：双引号 / 单引号 / 无引号
const ATTR_VALUE = `(?:"([^"]*)"|'([^']*)'|([^\\s"'\`=<>]+))`;

function pickValue(dq, sq, uq) {
  if (dq !== undefined) return { quote: '"', value: dq };
  if (sq !== undefined) return { quote: "'", value: sq };
  return { quote: '', value: uq || '' };
}

function rewriteHtml(html, base) {
  let out = html;

  // <base> 会把相对路径指向代理域，必须移除
  out = out.replace(/<base\b[^>]*>/gi, '');
  // SRI 校验在内容被改写后必然失败，移除 integrity
  out = out.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*')/gi, '');

  // srcset 需先处理，避免被通用属性规则破坏逗号分隔结构
  out = out.replace(new RegExp(`(\\s)srcset\\s*=\\s*${ATTR_VALUE}`, 'gi'), (m, sp, dq, sq, uq) => {
    const { quote, value } = pickValue(dq, sq, uq);
    const rewritten = value
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return '';
        const pieces = trimmed.split(/\s+/);
        pieces[0] = rewriteOne(pieces[0], base);
        return pieces.join(' ');
      })
      .filter(Boolean)
      .join(', ');
    return `${sp}srcset=${quote}${rewritten}${quote}`;
  });

  // HTML 允许无引号属性值（压缩后的页面极常见），三种形式都要覆盖
  out = out.replace(
    new RegExp(`(\\s)(${REWRITABLE_ATTRS.join('|')})\\s*=\\s*${ATTR_VALUE}`, 'gi'),
    (m, sp, name, dq, sq, uq) => {
      const { quote, value } = pickValue(dq, sq, uq);
      return `${sp}${name}=${quote}${rewriteOne(value, base)}${quote}`;
    }
  );

  // meta refresh
  out = out.replace(
    /(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*)(["'])([^"']*)\2/gi,
    (m, head, quote, content) => {
      const replaced = content.replace(/(url\s*=\s*)([^;]+)/i, (mm, p, u) => p + rewriteOne(u.trim(), base));
      return `${head}${quote}${replaced}${quote}`;
    }
  );

  // 行内 style 的 url()
  out = out.replace(/(\sstyle\s*=\s*)("[^"]*"|'[^']*')/gi, (m, head, quoted) => {
    const quote = quoted[0];
    return `${head}${quote}${rewriteCss(quoted.slice(1, -1), base)}${quote}`;
  });

  // <style> 块
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, body, close) => {
    return open + rewriteCss(body, base) + close;
  });

  return out;
}

function rewriteCss(css, base) {
  let out = css.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, quote, value) => {
    return `url(${quote}${rewriteOne(value.trim(), base)}${quote})`;
  });
  out = out.replace(/@import\s+(["'])([^"']+)\1/gi, (m, quote, value) => {
    return `@import ${quote}${rewriteOne(value.trim(), base)}${quote}`;
  });
  return out;
}

function rewriteOne(value, base) {
  const v = String(value || '').trim();
  if (!v) return value;
  // 非网络资源、锚点、协议相对以外的特殊协议一律不动
  if (/^(#|data:|blob:|javascript:|mailto:|tel:|about:|chrome:|file:|sms:|ftp:)/i.test(v)) return value;

  try {
    const abs = new URL(v, base);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return value;
    if (abs.href === base.toString()) return value;
    return toProxyUrl(abs.toString());
  } catch {
    return value;
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function extractCharset(contentType) {
  const m = /charset=([^;]+)/i.exec(contentType || '');
  return m ? m[1].trim().replace(/^["']|["']$/g, '').toLowerCase() : null;
}

function decodeBody(buffer, charset) {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function errorResponse(status, message) {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>代理错误 ${status}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e6e8eb;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:640px;padding:32px;border:1px solid #2a2f3a;border-radius:12px;background:#171a21}
h1{font-size:18px;margin:0 0 12px}p{line-height:1.7;color:#b6bcc6;word-break:break-all;margin:0}</style>
</head><body><div class="box"><h1>代理错误 ${status}</h1><p>${escapeHtml(message)}</p></div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ROOT_FALLBACK_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Everything</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">
<h1>Proxy Everything</h1>
<p>用法：在地址后追加目标地址，例如 <code>/https://example.com/</code></p>
</body></html>`;
