// Minimal XML parser sufficient for Jenkins config.xml: elements, attributes, text, CDATA, comments, entities.
// Returns { name, attrs, children, text } nodes. No namespaces handling beyond keeping names verbatim.

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return e in ENT ? ENT[e] : m;
  });
}

export function parseXml(src) {
  let i = 0;
  const n = src.length;
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const cur = () => stack[stack.length - 1];
  while (i < n) {
    if (src[i] !== '<') {
      const j = src.indexOf('<', i);
      const end = j === -1 ? n : j;
      const t = decodeEntities(src.slice(i, end));
      cur().text += t;
      i = end;
      continue;
    }
    if (src.startsWith('<!--', i)) { const j = src.indexOf('-->', i); i = j === -1 ? n : j + 3; continue; }
    if (src.startsWith('<![CDATA[', i)) { const j = src.indexOf(']]>', i); cur().text += src.slice(i + 9, j === -1 ? n : j); i = j === -1 ? n : j + 3; continue; }
    if (src.startsWith('<?', i)) { const j = src.indexOf('?>', i); i = j === -1 ? n : j + 2; continue; }
    if (src.startsWith('<!', i)) { const j = src.indexOf('>', i); i = j === -1 ? n : j + 1; continue; }
    if (src.startsWith('</', i)) { const j = src.indexOf('>', i); i = j === -1 ? n : j + 1; if (stack.length > 1) stack.pop(); continue; }
    // start tag
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(i + 1, j);
    const attrs = {};
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '/' || src[j] === '>') break;
      let k = j; while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(j, k); j = k;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '=') {
        j++; while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); attrs[an] = decodeEntities(src.slice(j + 1, e === -1 ? n : e)); j = e === -1 ? n : e + 1; }
        else { let e = j; while (e < n && !/[\s/>]/.test(src[e])) e++; attrs[an] = src.slice(j, e); j = e; }
      } else attrs[an] = '';
    }
    const selfClose = src[j] === '/';
    while (j < n && src[j] !== '>') j++;
    i = j + 1;
    const node = { name, attrs, children: [], text: '' };
    cur().children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

// Helpers
export const child = (node, name) => (node ? node.children.find((c) => c.name === name) : undefined);
export const children = (node, name) => (node ? node.children.filter((c) => !name || c.name === name) : []);
export const text = (node, name) => { const c = name ? child(node, name) : node; return c ? c.text.trim() : ''; };
export const path = (node, ...names) => names.reduce((n, nm) => child(n, nm), node);
export function findAll(node, pred, out = []) { for (const c of node.children) { if (pred(c)) out.push(c); findAll(c, pred, out); } return out; }
