// Generate public/index.html and public/<slug>/index.html from site/template.html + site/sources.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PAGES, SITE } from './sources.js';
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
writeFileSync('public/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map((p) => `  <url><loc>${SITE}${p.path}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync('public/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
