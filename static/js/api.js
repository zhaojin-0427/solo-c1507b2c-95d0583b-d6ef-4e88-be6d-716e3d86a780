/* 后端 API 封装 */
const API = {
  async _req(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  },
  nest(payload) { return this._req('POST', '/api/nest', payload); },
  listProjects() { return this._req('GET', '/api/projects'); },
  saveProject(id, name, data) { return this._req('POST', '/api/projects', { id, name, data }); },
  loadProject(id) { return this._req('GET', '/api/projects/' + id); },
  deleteProject(id) { return this._req('DELETE', '/api/projects/' + id); },
};
