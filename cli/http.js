// Tiny fetch helper shared by the platform crawlers.
export function client({ base = '', headers = {}, auth = null, insecure = false } = {}) {
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const h = { Accept: 'application/json', 'User-Agent': 'jenkins-to-actions', ...headers };
  if (auth && auth.basic) h.Authorization = 'Basic ' + Buffer.from(auth.basic).toString('base64');
  if (auth && auth.bearer) h.Authorization = `Bearer ${auth.bearer}`;
  const get = async (url, { text = false, headers: extra = {}, allow404 = false } = {}) => {
    const full = url.startsWith('http') ? url : `${base}${url}`;
    const res = await fetch(full, { headers: { ...h, ...extra } });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) { const body = await res.text().catch(() => ''); const e = new Error(`${res.status} ${res.statusText} for ${full.replace(/\?.*/, '')}${body ? ': ' + body.slice(0, 160).replace(/\s+/g, ' ') : ''}`); e.status = res.status; throw e; }
    return text ? res.text() : res.json();
  };
  const send = async (method, url, body, { headers: extra = {} } = {}) => {
    const full = url.startsWith('http') ? url : `${base}${url}`;
    const res = await fetch(full, { method, headers: { ...h, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error(`${method} ${full.replace(/\?.*/, '')} → ${res.status}: ${t.slice(0, 200).replace(/\s+/g, ' ')}`); e.status = res.status; e.body = t; throw e; }
    return res.status === 204 ? null : res.json();
  };
  // Page through list endpoints that return arrays (GitHub/GitLab style with per_page/page).
  const pages = async (url, { key = null, per = 100, param = 'page', max = 50 } = {}) => {
    const out = [];
    for (let p = 1; p <= max; p++) {
      const sep = url.includes('?') ? '&' : '?';
      const r = await get(`${url}${sep}per_page=${per}&${param}=${p}`);
      const list = key ? r[key] : r;
      if (!Array.isArray(list) || list.length === 0) break;
      out.push(...list);
      if (list.length < per) break;
    }
    return out;
  };
  return { get, send, pages, headers: h };
}

export const progress = (() => { let last = 0; return (msg) => { const now = Date.now(); if (now - last < 80 && !msg.endsWith('\n')) return; last = now; process.stderr.write(`\r${msg.slice(0, 100).padEnd(100)}`); }; })();
export const progressDone = () => process.stderr.write('\n');

// Known CI config paths, in the order they are probed.
export const CI_FILES = [
  { path: 'Jenkinsfile', system: 'jenkins' },
  { path: '.gitlab-ci.yml', system: 'gitlab' },
  { path: 'azure-pipelines.yml', system: 'azure' },
  { path: 'azure-pipelines.yaml', system: 'azure' },
  { path: '.azure-pipelines/azure-pipelines.yml', system: 'azure' },
  { path: '.circleci/config.yml', system: 'circleci' },
  { path: 'bitbucket-pipelines.yml', system: 'bitbucket' },
  { path: '.travis.yml', system: 'travis' },
];
