import { SOURCES } from './converters/index.js';
const $ = (id) => document.getElementById(id);
const source = document.body.dataset.source || 'jenkins';
const inEl = $('in'), outEl = $('out'), notes = $('notes'), notesList = $('notes-list');
let lastYaml = '';
let convertFn = null;
const ready = SOURCES[source].load().then((m) => { convertFn = m.convert; });
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function highlight(yaml) {
  return yaml.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return `<span class="c">${esc(line)}</span>`;
    const m = /^(\s*(?:- )?)([A-Za-z0-9_.'"-]+)(:)(\s.*|$)/.exec(line);
    if (m) {
      let v = esc(m[4]);
      v = v.replace(/(\$\{\{[^}]*\}\})/g, '<span class="t">$1</span>');
      return `${m[1]}<span class="k">${esc(m[2])}</span>${m[3]}${v}`;
    }
    return esc(line).replace(/(\$\{\{[^}]*\}\})/g, '<span class="t">$1</span>');
  }).join('\n');
}
function md(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }
function run() {
  const src = inEl.value;
  $('inmeta').textContent = src ? `${src.split('\n').length} lines` : '';
  if (!src.trim()) { outEl.innerHTML = `<span class="c"># Paste your ${esc(SOURCES[source].file)} on the left, or load an example.</span>`; notes.hidden = true; lastYaml = ''; return; }
  if (!convertFn) { ready.then(run); return; }
  const opts = { runner: $('runner').value, workflowName: $('wfname').value.trim(), checkout: $('checkout').checked };
  if ($('mode')) opts.mode = $('mode').value;
  let res;
  try { res = convertFn(src, opts); } catch (e) { res = { yaml: '', notes: [`Converter crashed: ${e.message}. Please email this file so it can become a test case.`], error: true }; }
  lastYaml = res.yaml;
  outEl.innerHTML = res.yaml ? highlight(res.yaml) : '<span class="c"># Could not convert.</span>';
  $('outmeta').textContent = res.yaml ? `${res.yaml.split('\n').length} lines` : '';
  notesList.innerHTML = res.notes.map((n) => `<li>${md(n)}</li>`).join('');
  notes.hidden = false;
  notes.classList.toggle('ok', res.notes.length === 0);
  $('notes-title').textContent = res.notes.length ? `Review before you commit (${res.notes.length})` : 'Converted with nothing to flag. Still read it before you commit.';
  if (!res.notes.length) notesList.innerHTML = '';
  try { localStorage.setItem(`j2a-src-${source}`, src); } catch {}
}
let t; inEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 150); });
for (const id of ['mode', 'runner', 'wfname', 'checkout']) if ($(id)) $(id).addEventListener('change', run);
$('wfname').addEventListener('input', run);
$('copy').addEventListener('click', async () => { if (!lastYaml) return; try { await navigator.clipboard.writeText(lastYaml); $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy YAML'), 1200); } catch {} });
$('download').addEventListener('click', () => { if (!lastYaml) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lastYaml], { type: 'text/yaml' })); a.download = 'ci.yml'; a.click(); URL.revokeObjectURL(a.href); });
$('example').addEventListener('change', async (e) => { const v = e.target.value; if (!v) return; const r = await fetch(`/examples/${v}`); inEl.value = await r.text(); run(); e.target.value = ''; });
try { const saved = localStorage.getItem(`j2a-src-${source}`); if (saved) inEl.value = saved; } catch {}
run();
