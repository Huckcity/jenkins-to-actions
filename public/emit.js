// YAML emitter with comment support, shared by every converter.

// ---------------------------------------------------------------- YAML emitter (with comment support)

export class Comment { constructor(text) { this.text = text; } }
const NEEDS_QUOTE = /^(?:true|false|yes|no|on|off|null|~|y|n)$|^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$|^0x[0-9a-f]+$|^[\s]|[\s]$|^[-?:,\[\]{}#&*!|>'"%@`]|: | #|^$|[\n\t]/i;
function yStr(s) {
  s = String(s);
  if (NEEDS_QUOTE.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s) || /^-? /.test(s) || s.startsWith('- ') || s === '-' || /\*/.test(s)) {
    if (s.includes("'") && !s.includes('"') && !s.includes('\\')) return '"' + s + '"';
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return s;
}
function yKey(k) { if (k === "on") return k; return /^[A-Za-z0-9_.-]+$/.test(k) && !NEEDS_QUOTE.test(k) ? k : yStr(k); }

export function toYaml(value, indent = 0, lines = []) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) { lines.push(pad + '[]'); return lines; }
    for (const item of value) {
      if (item instanceof Comment) { for (const l of item.text.split('\n')) lines.push(pad + '# ' + l); continue; }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const sub = toYaml(item, indent + 2, []);
        if (sub.length === 0) { lines.push(pad + '- {}'); continue; }
        // first line gets the dash; comment lines first stay as comments
        let first = true;
        for (const l of sub) {
          if (first && !l.trim().startsWith('#')) { lines.push(pad + '- ' + l.slice(indent + 2)); first = false; }
          else if (first) { lines.push(l); }
          else lines.push(l);
        }
      } else if (Array.isArray(item)) {
        const sub = toYaml(item, indent + 2, []);
        lines.push(pad + '-'); lines.push(...sub);
      } else {
        lines.push(pad + '- ' + scalar(item));
      }
    }
    return lines;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    for (const k of keys) {
      const v = value[k];
      if (k.startsWith('__comment')) { for (const l of String(v).split('\n')) lines.push(pad + '# ' + l); continue; }
      if (v === undefined) continue;
      if (v instanceof Comment) { for (const l of v.text.split('\n')) lines.push(pad + '# ' + l); continue; }
      if (Array.isArray(v)) {
        if (v.length === 0) { lines.push(`${pad}${yKey(k)}: []`); continue; }
        const allScalar = v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)) && v.length <= 6 && v.every((x) => String(x).length < 40);
        if (allScalar) { lines.push(`${pad}${yKey(k)}: [${v.map(scalar).join(', ')}]`); continue; }
        lines.push(`${pad}${yKey(k)}:`);
        toYaml(v, indent + 2, lines);
      } else if (v && typeof v === 'object') {
        if (Object.keys(v).length === 0) { lines.push(`${pad}${yKey(k)}: {}`); continue; }
        lines.push(`${pad}${yKey(k)}:`);
        toYaml(v, indent + 2, lines);
      } else if (typeof v === 'string' && v.includes('\n')) {
        const body = v.replace(/\n+$/, '');
        lines.push(`${pad}${yKey(k)}: |`);
        for (const l of body.split('\n')) lines.push(l.trim() === '' ? '' : pad + '  ' + l);
      } else {
        lines.push(`${pad}${yKey(k)}: ${scalar(v)}`);
      }
    }
    return lines;
  }
  lines.push(pad + scalar(value));
  return lines;
}
function scalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return yStr(v);
}

