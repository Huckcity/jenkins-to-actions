// GitHub Actions cost calculator. List prices (USD per minute) and plan allowances as published by GitHub, 2026.
const RUNNERS = [
  ['linux-2', 'Linux 2-core (ubuntu-latest)', 0.008, 1, true],
  ['linux-4', 'Linux 4-core', 0.016, 0, false], ['linux-8', 'Linux 8-core', 0.032, 0, false], ['linux-16', 'Linux 16-core', 0.064, 0, false], ['linux-32', 'Linux 32-core', 0.128, 0, false], ['linux-64', 'Linux 64-core', 0.256, 0, false],
  ['arm-2', 'Linux Arm 2-core (ubuntu-24.04-arm)', 0.005, 1, true], ['arm-4', 'Linux Arm 4-core', 0.01, 0, true], ['arm-8', 'Linux Arm 8-core', 0.02, 0, false],
  ['windows-2', 'Windows 2-core (windows-latest)', 0.016, 2, true], ['windows-4', 'Windows 4-core', 0.032, 0, false], ['windows-8', 'Windows 8-core', 0.064, 0, false], ['windows-16', 'Windows 16-core', 0.128, 0, false],
  ['macos-4', 'macOS 3/4-core (macos-latest)', 0.08, 10, true], ['macos-12', 'macOS large, 12-core Intel', 0.12, 0, false], ['macos-6', 'macOS xlarge, M-series', 0.16, 0, false],
  ['gpu-linux-4', 'Linux GPU 4-core (T4)', 0.07, 0, false],
];
const PLANS = { free: 2000, pro: 3000, team: 3000, enterprise: 50000 };
const $ = (s) => document.querySelector(s);
const fmt = (n) => (n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 10 ? '$' + n.toFixed(1) : '$' + n.toFixed(2));
const rows = $('#rows');
function addRow(key = 'linux-2', minutes = '') {
  const div = document.createElement('div'); div.className = 'row';
  const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Runner type');
  for (const [k, label] of RUNNERS) { const o = document.createElement('option'); o.value = k; o.textContent = label; if (k === key) o.selected = true; sel.appendChild(o); }
  const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.step = '10'; inp.placeholder = '0'; inp.value = minutes; inp.setAttribute('aria-label', 'Minutes per month');
  const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×'; rm.setAttribute('aria-label', 'Remove'); rm.className = 'rm';
  rm.addEventListener('click', () => { div.remove(); calc(); save(); });
  sel.addEventListener('change', () => { calc(); save(); }); inp.addEventListener('input', () => { calc(); save(); });
  div.append(sel, inp, rm); rows.appendChild(div);
}
function state() { return [...rows.querySelectorAll('.row:not(.head)')].map((r) => ({ key: r.querySelector('select').value, minutes: Math.max(0, parseFloat(r.querySelector('input').value) || 0) })); }
function save() { try { localStorage.setItem('calc', JSON.stringify({ plan: $('#plan').value, vis: $('#visibility').value, rows: state() })); } catch {} }
function calc() {
  const plan = $('#plan').value, isPublic = $('#visibility').value === 'public';
  let included = PLANS[plan];
  const lines = []; let total = 0, standardMinutes = 0, multiplied = 0;
  const items = state().filter((x) => x.minutes > 0);
  for (const { key, minutes } of items) {
    const r = RUNNERS.find((x) => x[0] === key); const [, label, rate, mult, standard] = r;
    let billable = minutes, covered = 0, note = '';
    if (standard && isPublic) { billable = 0; note = 'free on public repositories'; }
    else if (standard && mult > 0) {
      standardMinutes += minutes; multiplied += minutes * mult;
      const consumes = minutes * mult; const use = Math.min(included, consumes); included -= use;
      covered = use / mult; billable = minutes - covered;
      note = covered > 0 ? `${Math.round(covered).toLocaleString('en-US')} min covered by included minutes${mult > 1 ? ` (×${mult})` : ''}` : (mult > 1 ? `×${mult} against included minutes` : '');
    } else note = 'larger runners are never covered by included minutes';
    const cost = billable * rate; total += cost;
    lines.push({ label, minutes, billable, rate, cost, note });
  }
  $('#total').textContent = fmt(total);
  const t = $('#result'); t.innerHTML = '';
  if (!lines.length) { t.innerHTML = '<tr><td class="muted">Add minutes on the left.</td></tr>'; $('#note').textContent = ''; $('#alt').innerHTML = ''; return; }
  t.innerHTML = '<tr><th>Runner</th><th>Minutes</th><th>Billed</th><th>Cost</th></tr>' + lines.map((l) => `<tr><td>${l.label}<br><span class="muted">${l.note}</span></td><td>${l.minutes.toLocaleString('en-US')}</td><td>${Math.round(l.billable).toLocaleString('en-US')}</td><td>${fmt(l.cost)}</td></tr>`).join('');
  const inc = PLANS[plan];
  $('#note').textContent = isPublic ? 'Standard runners are free for public repositories; only larger runners are billed.' : `Your standard-runner minutes consume ${Math.round(multiplied).toLocaleString('en-US')} of the ${inc.toLocaleString('en-US')} included minutes after multipliers${multiplied > inc ? `; ${Math.round(multiplied - inc).toLocaleString('en-US')} multiplied minutes are overage` : ''}.`;
  // Alternatives: all minutes on Linux 2-core; on Linux 8-core at 1/3 the time; self-hosted at a flat VM rate.
  const allMin = items.reduce((s, x) => s + x.minutes, 0);
  const linuxCost = Math.max(0, allMin - (isPublic ? allMin : inc)) * 0.008;
  const alts = [
    ['Everything on Linux 2-core', fmt(linuxCost), 'if nothing truly needs Windows or macOS'],
    ['Everything on Linux 8-core, jobs 3× faster', fmt((allMin / 3) * 0.032), 'CPU-bound jobs often finish in a third of the time; larger runners skip the included minutes'],
    ['Self-hosted at $0.0015/min (dedicated 2-vCPU VM, 100% busy)', fmt(allMin * 0.0015), 'plus the engineer-time to run them; idle time raises the real figure several-fold'],
  ];
  $('#alt').innerHTML = alts.map((a) => `<tr><td>${a[0]}<br><span class="muted">${a[2]}</span></td><td>${a[1]}</td></tr>`).join('');
}
$('#add').addEventListener('click', () => { addRow(); calc(); });
$('#plan').addEventListener('change', () => { calc(); save(); }); $('#visibility').addEventListener('change', () => { calc(); save(); });
let saved = null; try { saved = JSON.parse(localStorage.getItem('calc') || 'null'); } catch {}
if (saved && saved.rows && saved.rows.length) { $('#plan').value = saved.plan; $('#visibility').value = saved.vis; for (const r of saved.rows) addRow(r.key, r.minutes || ''); }
else { addRow('linux-2', 4000); addRow('macos-4', 300); addRow('windows-2', 500); }
calc();
