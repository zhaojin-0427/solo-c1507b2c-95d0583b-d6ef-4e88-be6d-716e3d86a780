/* 零件容缺设置：正反面要求、允许缺陷等级、在零件示意图上圈出容许缺陷区域。
 *
 * 容许区 allowZones: [{points:[{x,y}...]}]，坐标为零件局部坐标（未旋转，
 * 原点左上角，宽=part.width、高=part.height）。容许区内的同等级及以下缺陷
 * 核心在排样时可被该零件覆盖（仍受其他面别/外扩规则约束，见 defects.js）。
 */
const PartTol = {
  NS: 'http://www.w3.org/2000/svg',
  part: null,
  scale: 1,
  draftVerts: null,

  openModal(p) {
    this.part = p;
    // 兼容旧项目数据
    if (p.faceReq == null) p.faceReq = 'any';
    if (p.allowGrade == null) p.allowGrade = 0;
    if (!Array.isArray(p.allowZones)) p.allowZones = [];
    this.draftVerts = null;

    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal wide">
        <h3>容缺设置 — ${esc(p.name || p.id)}（${p.width}×${p.height} mm）</h3>
        <div class="tol-grid">
          <div class="tol-fields">
            <label>正反面要求
              <select id="tol-face">
                <option value="any"${p.faceReq === 'any' ? ' selected' : ''}>正反面均可（可翻板避让）</option>
                <option value="front"${p.faceReq === 'front' ? ' selected' : ''}>正面为可见面（正面须无缺陷）</option>
                <option value="back"${p.faceReq === 'back' ? ' selected' : ''}>反面为可见面（反面须无缺陷）</option>
                <option value="both"${p.faceReq === 'both' ? ' selected' : ''}>双面均可见（双面都须无缺陷）</option>
              </select>
            </label>
            <label>允许的缺陷等级（整件范围）
              <select id="tol-grade">
                <option value="0"${(+p.allowGrade) === 0 ? ' selected' : ''}>0 — 不容许任何缺陷</option>
                <option value="1"${(+p.allowGrade) === 1 ? ' selected' : ''}>1 — 可接受轻微（1 级）</option>
                <option value="2"${(+p.allowGrade) === 2 ? ' selected' : ''}>2 — 可接受轻微/中等（≤2 级）</option>
                <option value="3"${(+p.allowGrade) === 3 ? ' selected' : ''}>3 — 任意等级均可接受</option>
              </select>
            </label>
            <p class="hint">在右侧示意图上单击圈出"容许缺陷区域"多边形（逐点单击，双击闭合）。
              落入容许区内、等级不高于上限的缺陷核心可被该零件覆盖；
              安全外扩量与零件间距仍照常保留。</p>
            <div id="tol-zones"></div>
            <div class="tol-tools">
              <button id="tol-draw">✏ 圈容许区</button>
              <button id="tol-clear-draft">取消绘制</button>
            </div>
          </div>
          <div class="tol-canvas-wrap">
            <svg id="tol-svg" xmlns="http://www.w3.org/2000/svg"></svg>
          </div>
        </div>
        <div class="foot">
          <button id="tol-cancel">取消</button>
          <button id="tol-ok" class="primary">确定</button>
        </div>
      </div>`;

    document.getElementById('tol-face').addEventListener('change', e => { p.faceReq = e.target.value; });
    document.getElementById('tol-grade').addEventListener('change', e => { p.allowGrade = +e.target.value; });
    const close = () => { root.innerHTML = ''; };
    document.getElementById('tol-cancel').addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.getElementById('tol-ok').addEventListener('click', () => {
      // 未闭合的草稿丢弃
      this.draftVerts = null;
      App.pushHistory();
      close();
      renderAll();
      toast('容缺设置已保存');
    });
    document.getElementById('tol-draw').addEventListener('click', () => {
      this.draftVerts = [];
      toast('逐点单击圈容许区，双击或回到起点闭合');
      this.renderSvg();
    });
    document.getElementById('tol-clear-draft').addEventListener('click', () => {
      this.draftVerts = null; this.renderSvg();
    });
    this.bindSvg();
    this.renderSvg();
    this.renderZoneList();
  },

  bindSvg() {
    const svg = document.getElementById('tol-svg');
    const toLocal = (e) => {
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      return {
        x: (e.clientX - r.left) / r.width * vb.width,
        y: (e.clientY - r.top) / r.height * vb.height,
      };
    };
    svg.addEventListener('click', (e) => {
      if (!this.draftVerts) return;
      const q = toLocal(e);
      const first = this.draftVerts[0];
      if (first && this.draftVerts.length >= 3 &&
          Math.hypot(q.x - first.x, q.y - first.y) < 12) {
        this.finishZone();
        return;
      }
      if (!this.draftVerts.some(v => Math.hypot(v.x - q.x, v.y - q.y) < 5)) {
        this.draftVerts.push({ x: Math.round(q.x), y: Math.round(q.y) });
        this.renderSvg();
      }
    });
    svg.addEventListener('dblclick', () => {
      if (this.draftVerts && this.draftVerts.length >= 3) this.finishZone();
    });
    svg.addEventListener('mousemove', (e) => {
      if (!this.draftVerts || !this.draftVerts.length) return;
      this._hover = toLocal(e);
      this.renderSvg(true);
    });
  },

  finishZone() {
    const pts = this.draftVerts.slice();
    this.draftVerts = null;
    this.part.allowZones.push({ points: pts });
    this.renderSvg();
    this.renderZoneList();
    toast('容许区已添加，可继续圈画或确定保存');
  },

  renderZoneList() {
    const box = document.getElementById('tol-zones');
    if (!box) return;
    const zones = this.part.allowZones || [];
    box.innerHTML = zones.length
      ? zones.map((z, i) =>
          `<div class="tol-zone-row">区域 ${i + 1}（${z.points.length} 点，面积 ${fmtArea(Defects.polyArea(z.points))}）
            <button data-i="${i}" class="tol-del-z">删除</button></div>`).join('')
      : '<p class="hint">暂不容许缺陷出现在零件任何位置。</p>';
    box.querySelectorAll('.tol-del-z').forEach(b => b.addEventListener('click', () => {
      this.part.allowZones.splice(+b.dataset.i, 1);
      this.renderSvg();
      this.renderZoneList();
    }));
  },

  renderSvg(keepHover) {
    const svg = document.getElementById('tol-svg');
    const p = this.part;
    const pad = 40;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${(+p.width) + pad * 2} ${(+p.height) + pad * 2}`);
    svg.replaceChildren();
    const mk = (tag, attrs) => {
      const n = document.createElementNS(this.NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
      return n;
    };
    mk('rect', { x: 0, y: 0, width: p.width, height: p.height, class: 'tol-part' });
    // 纹理/正反面示意
    const t = mk('text', { x: 8, y: 24, class: 'tol-face-tag' });
    t.textContent = { any: '正反面均可', front: '正面（可见面）', back: '反面（可见面）', both: '双面可见' }[p.faceReq || 'any'];
    const tag2 = mk('text', { x: 8, y: +p.height - 10, class: 'tol-dim-tag' });
    tag2.textContent = `允许 ≤ ${p.allowGrade} 级 · ${p.width}×${p.height}`;

    (p.allowZones || []).forEach((z, i) => {
      const pts = z.points.map(q => `${q.x},${q.y}`).join(' ');
      mk('polygon', { points: pts, class: 'tol-zone' });
      const cx = z.points.reduce((s, q) => s + q.x, 0) / z.points.length;
      const cy = z.points.reduce((s, q) => s + q.y, 0) / z.points.length;
      const tt = mk('text', { x: cx, y: cy + 6, class: 'tol-zone-tag', 'text-anchor': 'middle' });
      tt.textContent = '容许区 ' + (i + 1);
    });

    if (this.draftVerts && this.draftVerts.length) {
      const v = this.draftVerts;
      const poly = v.concat(keepHover && this._hover ? [this._hover] : []);
      if (poly.length >= 2) {
        mk('polyline', { points: poly.map(q => `${q.x},${q.y}`).join(' '), class: 'tol-draft' });
      }
      v.forEach(q => mk('circle', { cx: q.x, cy: q.y, r: 5, class: 'tol-draft-v' }));
    }
  },
};
