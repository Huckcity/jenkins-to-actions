// Generate public/index.html and public/<slug>/index.html from site/template.html + site/sources.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PAGES, SITE, STATIC_PAGES } from './sources.js';
const tpl = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
for (const p of PAGES) {
  const nav = PAGES.map((q) => (q === p ? `<a class="current" aria-current="page" href="${q.path}">${q.h1}</a>` : `<a href="${q.path}">${q.h1}</a>`)).join('<span aria-hidden="true">·</span>');
  const html = tpl
    .replace(/\{\{TITLE\}\}/g, esc(p.title)).replace(/\{\{OG_TITLE\}\}/g, esc(p.ogTitle)).replace(/\{\{DESCRIPTION\}\}/g, esc(p.description))
    .replace(/\{\{PATH\}\}/g, p.path).replace(/\{\{SOURCE\}\}/g, p.source).replace(/\{\{H1\}\}/g, esc(p.h1)).replace(/\{\{INPUT_LABEL\}\}/g, esc(p.inputLabel))
    .replace('{{EXAMPLES}}', p.examples.map(([f, label]) => `      <option value="${f}">${esc(label)}</option>`).join('\n'))
    .replace('{{LAYOUT_OPTION}}', p.layout ? '    <label>Layout\n      <select id="mode">\n        <option value="jobs">One job per stage</option>\n        <option value="single">Single job (stages become steps)</option>\n      </select>\n    </label>' : '')
    .replace('{{PLACEHOLDER}}', esc(p.placeholder).replace(/\n/g, '&#10;'))
    .replace('{{NAV}}', `<span>Convert from:</span>${nav}`)
    .replace('{{DOC}}', p.doc);
  const out = p.slug ? `public/${p.slug}/index.html` : 'public/index.html';
  if (p.slug) mkdirSync(`public/${p.slug}`, { recursive: true });
  writeFileSync(out, html);
  console.log('wrote', out);
}
// Static pages share the template's <head> and CSS; their body comes from site/<slug>.html.
const head = tpl.slice(0, tpl.indexOf('<body>') + '<body>'.length);
const tail = tpl.slice(tpl.indexOf('<footer>'));
for (const p of STATIC_PAGES) {
  const body = readFileSync(new URL(`./${p.slug}.html`, import.meta.url), 'utf8');
  const html = head.replace(/\{\{TITLE\}\}/g, esc(p.title)).replace(/\{\{OG_TITLE\}\}/g, esc(p.ogTitle)).replace(/\{\{DESCRIPTION\}\}/g, esc(p.description)).replace(/\{\{PATH\}\}/g, p.path).replace(/\{\{SOURCE\}\}/g, '')
    + `\n<header><h1><a href="/" style="color:inherit;text-decoration:none">ci2actions.dev</a> <span>CI → GitHub Actions</span></h1><nav class="sources" aria-label="Converters"><span>Convert from:</span>${PAGES.map((q) => `<a href="${q.path}">${q.h1}</a>`).join('<span aria-hidden="true">·</span>')}</nav></header>\n`
    + body + tail.replace('<script type="module" src="/app.js"></script>\n', '');
  mkdirSync(`public/${p.slug}`, { recursive: true });
  writeFileSync(`public/${p.slug}/index.html`, html);
  console.log('wrote', `public/${p.slug}/index.html`);
}
const ALL = [...PAGES, ...STATIC_PAGES];
writeFileSync('public/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${ALL.map((p) => `  <url><loc>${SITE}${p.path}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync('public/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
