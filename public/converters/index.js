// Registry of source systems. Each converter exports convert(src, options) -> { yaml, notes, secrets }.
export const SOURCES = {
  jenkins: { name: 'Jenkins', file: 'Jenkinsfile', load: () => import('../convert.js') },
  gitlab: { name: 'GitLab CI', file: '.gitlab-ci.yml', load: () => import('./gitlab.js') },
  azure: { name: 'Azure Pipelines', file: 'azure-pipelines.yml', load: () => import('./azure.js') },
  circleci: { name: 'CircleCI', file: '.circleci/config.yml', load: () => import('./circleci.js') },
  bitbucket: { name: 'Bitbucket Pipelines', file: 'bitbucket-pipelines.yml', load: () => import('./bitbucket.js') },
  travis: { name: 'Travis CI', file: '.travis.yml', load: () => import('./travis.js') },
};

// Guess the source system from a file name or the content.
export function detect(filename = '', content = '') {
  const f = String(filename).replace(/\\/g, '/');
  if (/Jenkinsfile/i.test(f)) return 'jenkins';
  if (/\.gitlab-ci\.ya?ml$/.test(f)) return 'gitlab';
  if (/azure-pipelines.*\.ya?ml$/.test(f) || /\.azure-pipelines\//.test(f)) return 'azure';
  if (/\.circleci\/config\.ya?ml$/.test(f)) return 'circleci';
  if (/bitbucket-pipelines\.ya?ml$/.test(f)) return 'bitbucket';
  if (/\.travis\.ya?ml$/.test(f)) return 'travis';
  const c = String(content);
  if (/^\s*pipeline\s*\{|^\s*node\s*(\(|\{)|^\s*@Library/m.test(c)) return 'jenkins';
  if (/^\s*pipelines:\s*$/m.test(c)) return 'bitbucket';
  if (/^\s*language:\s*\w+|^\s*(before_install|after_success|dist|rvm|node_js):/m.test(c)) return 'travis';
  if (/^\s*version:\s*2(\.1)?\s*$|^\s*orbs:|^\s*executors:|^\s*workflows:\s*$|^\s*-\s*checkout\s*$|docker:\s*\n\s*-\s*image:/m.test(c)) return 'circleci';
  if (/vmImage:|^\s*-\s*task:\s*[\w.]+@\d|^\s*-\s*(job|stage|deployment|script|bash|pwsh|powershell):|^\s*pool:|^\s*pr:|displayName:/m.test(c)) return 'azure';
  if (/^\s*stages:\s*|^\s*image:|^\s*before_script:|^\s*\.?[\w-]+:\s*\n\s+(stage|script|extends):|^\s*include:|^\s*variables:/m.test(c)) return 'gitlab';
  return 'jenkins';
}
