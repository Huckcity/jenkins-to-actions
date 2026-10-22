// Canonical host redirect in front of the static site: the old workers.dev URL and www both 301 to ci2actions.dev.
const CANONICAL = 'ci2actions.dev';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && !url.hostname.endsWith('.localhost') && url.hostname !== 'localhost') {
      url.hostname = CANONICAL; url.protocol = 'https:'; url.port = '';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
