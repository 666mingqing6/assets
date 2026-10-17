// 单元测试：验证 URL 解析与 HTML/CSS 改写逻辑（不依赖网络）
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const src = readFileSync(new URL('../mirror-eo/edge-functions/[[default]].js', import.meta.url), 'utf8');
const exported = ['rewriteHtml', 'rewriteCss', 'parseTarget', 'normalizeUrl', 'toProxyUrl', 'splitSetCookie'];
const tmp = new URL('./.test-module.mjs', import.meta.url);
writeFileSync(tmp, src + `\nexport { ${exported.join(', ')} };\n`);

const m = await import(pathToFileURL(fileURLToPath(tmp)).href);

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}\n  expect: ${expected}\n  actual: ${actual}`);
  }
}
function ok(name, cond, extra = '') {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
}

/* ---------- URL 归一化 ---------- */
eq('补协议', m.normalizeUrl('example.com/a', '').toString(), 'https://example.com/a');
eq('CDN 折叠 //', m.normalizeUrl('https:/example.com/a', '').toString(), 'https://example.com/a');
eq('http 保留', m.normalizeUrl('http://a.com/x', '').toString(), 'http://a.com/x');
eq('query 补回', m.normalizeUrl('https://a.com/p', '?x=1&y=2').toString(), 'https://a.com/p?x=1&y=2');
eq('已有 query 不覆盖', m.normalizeUrl('https://a.com/p?a=9', '?x=1').toString(), 'https://a.com/p?a=9');
eq('非法协议拒绝', m.normalizeUrl('ftp://a.com/x', ''), null);
eq('空值拒绝', m.normalizeUrl('', ''), null);

/* ---------- parseTarget ---------- */
eq('raw 形态', m.parseTarget(new URL('https://m.com/https://a.com/b/c.css')).toString(), 'https://a.com/b/c.css');
eq('编码形态', m.parseTarget(new URL('https://m.com/https%3A%2F%2Fa.com%2Fb')).toString(), 'https://a.com/b');
eq('b64 形态', m.parseTarget(new URL('https://m.com/u/' + Buffer.from('https://a.com/x').toString('base64url'))).toString(), 'https://a.com/x');

/* ---------- HTML 改写 ---------- */
const base = new URL('https://a.com/dir/page.html');
const html = `<html><head><base href="/"><link rel="stylesheet" href="/css/app.css" integrity="sha384-abc">
<script src="//cdn.a.com/lib.js"></script></head>
<body style="background:url(/img/bg.png)">
<img src="pic.png" srcset="pic1.png 1x, /pic2.png 2x" data-src="/lazy.jpg">
<a href="/about">关于</a><a href="#top">锚点</a><a href="mailto:x@a.com">邮件</a>
<form action="/submit"></form>
<style>.x{background:url(../font/a.woff2)}</style>
<meta http-equiv="refresh" content="0; url=/home">
</body></html>`;

const out = m.rewriteHtml(html, base);
const enc = (u) => '/' + encodeURI(u);

ok('移除 base', !out.includes('<base'));
ok('移除 integrity', !out.includes('integrity'));
ok('根路径 css', out.includes(`href="${enc('https://a.com/css/app.css')}"`), out);
ok('协议相对脚本', out.includes(enc('https://cdn.a.com/lib.js')), out);
ok('相对图片解析', out.includes(enc('https://a.com/dir/pic.png')), out);
ok('srcset 第一项', out.includes(enc('https://a.com/dir/pic1.png') + ' 1x'), out);
ok('srcset 第二项', out.includes(enc('https://a.com/pic2.png') + ' 2x'), out);
ok('data-src', out.includes(enc('https://a.com/lazy.jpg')), out);
ok('行内 style url', out.includes(`url(${enc('https://a.com/img/bg.png')})`), out);
ok('style 块相对 url', out.includes(`url(${enc('https://a.com/font/a.woff2')})`), out);
ok('锚点不动', out.includes('href="#top"'), out);
ok('mailto 不动', out.includes('href="mailto:x@a.com"'), out);
ok('form action', out.includes(`action="${enc('https://a.com/submit')}"`), out);
ok('meta refresh', out.includes(`url=${enc('https://a.com/home')}`), out);
ok('保留原始文本', out.includes('关于'), out);

/* ---------- 无引号属性（压缩页面极常见，如百度首页） ---------- */
const miniHtml = `<link rel=stylesheet type=text/css href=https://ss1.a.com/x.css><img src=/i/y.png><a href=/go>走</a>`;
const miniOut = m.rewriteHtml(miniHtml, new URL('https://a.com/'));
ok('无引号 href 绝对地址', miniOut.includes(`href=${enc('https://ss1.a.com/x.css')}`), miniOut);
ok('无引号 src 根路径', miniOut.includes(`src=${enc('https://a.com/i/y.png')}`), miniOut);
ok('无引号 a href', miniOut.includes(`href=${enc('https://a.com/go')}`), miniOut);
ok('无引号保留 rel/type', miniOut.includes('rel=stylesheet type=text/css'), miniOut);

/* ---------- CSS 改写 ---------- */
const css = `.a{background:url('/i/a.png')} .b{background:url(../i/b.png)} .c{src:url(data:font/woff;base64,AAA)} @import "/s/x.css";`;
const cssOut = m.rewriteCss(css, new URL('https://a.com/css/main.css'));
ok('css 根路径', cssOut.includes(`url('${enc('https://a.com/i/a.png')}')`), cssOut);
ok('css 相对路径', cssOut.includes(enc('https://a.com/i/b.png')), cssOut);
ok('css data uri 保留', cssOut.includes('data:font/woff;base64,AAA'), cssOut);
ok('css @import', cssOut.includes(enc('https://a.com/s/x.css')), cssOut);

/* ---------- Set-Cookie 拆分 ---------- */
const rawCookie =
  'sid=abc; Path=/; Domain=.a.com; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure; HttpOnly, ' +
  'theme=dark; Path=/app; SameSite=Lax';
const parts = m.splitSetCookie(rawCookie);
eq('cookie 条数', parts.length, 2);
ok('cookie 第一条完整', parts[0].includes('Expires=Wed, 21 Oct 2026 07:28:00 GMT'), parts[0]);
ok('cookie 第二条', parts[1].startsWith('theme=dark'), parts[1]);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
