/* 封边 UI：
 * 1) 零件四边编辑（外露/拼接/不处理 + 材料/厚度/修边余量）与毛坯计算实时预览；
 * 2) 封边工序面板：按材料+厚度合并批次，支持先短后长/先长后短/手动换序，统计用量。
 * 纯计算在 edging.js，本模块只做 DOM。
 */
const EdgeUI = {
  part: null,
  _mode: null,

  init() {
    const btn = document.getElementById('btn-edging');
    if (btn) btn.addEventListener('click', () => this.openBatches());
  },

  /* ================= 四边编辑 ================= */
  openPart(p, focusSide) {
    if (typeof Edging === 'undefined') { toast('封边模块未加载'); return; }
    Edging.ensureEdges(p);
    this.part = p;
    this._focus = focusSide || null;
    this._snapshot = JSON.stringify(p.edges);
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal wide edge-modal">
        <h3>四边封边 — ${esc(p.name || p.id)}
          <span class="hint">（成品 ${fmtNum(p.width)}×${fmtNum(p.height)} mm）</span></h3>
        <div class="edge-grid">
          <div class="edge-svg-wrap"><svg id="edge-svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
          <div class="edge-fields" id="edge-fields"></div>
        </div>
        <div id="edge-calc" class="edge-calc"></div>
        <p class="hint">外露边须封边（填材料与厚度）；拼接边是与其它零件相接的成品边，<b>不得封边</b>；
          不处理边保留板茬。毛坯宽 = 成品宽 − 左/右封边厚度 + 左/右修边余量，高度同理。
          修改四边后需重新生成排样（排样按毛坯外廓）。</p>
        <div class="foot">
          <button id="edge-cancel">取消</button>
          <button id="edge-ok" class="primary">确定并重新排样</button>
        </div>
      </div>`;
    this.renderFields();
    this.renderSvg();
    this.renderCalc();
    const close = (save) => {
      if (!save) this.part.edges = JSON.parse(this._snapshot);
      root.innerHTML = '';
      renderAll();
    };
    document.getElementById('edge-cancel').addEventListener('click', () => close(false));
    root.addEventListener('click', (e) => { if (e.target === root) close(false); });
    document.getElementById('edge-ok').addEventListener('click', () => {
      const issues = Edging.partIssues(p);
      const fatal = issues.filter(i => i.code === 'blanknonpositive');
      if (fatal.length && !confirm(fatal[0].msg + '\n\n仍要保存？（该零件将无法下料）')) return;
      App.pushHistory();
      root.innerHTML = '';
      Main.onStructureChanged(false);
    });
  },

  renderFields() {
    const p = this.part;
    const box = document.getElementById('edge-fields');
    const rows = [
      ['top', '上边'], ['right', '右边'], ['bottom', '下边'], ['left', '左边'],
    ];
    box.innerHTML = rows.map(([k, lab]) => {
      const e = Edging.edge(p, k);
      return `
      <div class="edge-row edge-kind-${e.kind}" data-side="${k}">
        <div class="edge-row-h"><b>${lab}</b>
          <select data-k="kind" data-side="${k}">
            <option value="exposed"${e.kind === 'exposed' ? ' selected' : ''}>外露（须封边）</option>
            <option value="join"${e.kind === 'join' ? ' selected' : ''}>拼接（不封边）</option>
            <option value="none"${e.kind === 'none' ? ' selected' : ''}>不处理</option>
          </select>
        </div>
        <div class="edge-row-b">
          <label>材料<input type="text" data-k="material" data-side="${k}"
             value="${esc(e.material)}" placeholder="如 PVC / ABS"${e.kind !== 'exposed' ? ' disabled' : ''}></label>
          <label>厚度<input type="number" min="0" step="0.1" data-k="thickness" data-side="${k}"
             value="${e.thickness}"${e.kind !== 'exposed' ? ' disabled' : ''}> mm</label>
          <label>修边余量<input type="number" min="0" step="0.1" data-k="trim" data-side="${k}"
             value="${e.trim}"${e.kind !== 'exposed' ? ' disabled' : ''}> mm</label>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('input,select').forEach(inp => {
      inp.addEventListener('input', () => {
        const side = inp.dataset.side, k = inp.dataset.k;
        const e = p.edges[side];
        if (k === 'kind') e.kind = inp.value;
        else if (k === 'material') e.material = inp.value;
        else e[k] = Math.max(0, +inp.value || 0);
        this.renderFields();
        this.renderSvg();
        this.renderCalc();
      });
      inp.addEventListener('change', () => {
        const side = inp.dataset.side, k = inp.dataset.k;
        if (k === 'thickness' || k === 'trim') inp.value = Math.max(0, +inp.value || 0);
      });
    });
  },

  renderCalc() {
    const p = this.part;
    const d = Edging.blankDims(p);
    const E = k => Edging.edge(p, k);
    const rows = Edging.visualEdges(p, false).map(e => {
      const comp = Edging.edgeComp(e);
      const tag = e.kind === 'exposed'
        ? `外露 · ${esc(e.material || '未填材料')} · ${fmtNum(e.thickness)}mm · 余量 ${fmtNum(e.trim)}`
        : e.kind === 'join' ? '拼接（不封边）' : '不处理';
      const expr = e.kind === 'exposed'
        ? `−${fmtNum(e.thickness)} + ${fmtNum(e.trim)}` : '0';
      return `<tr class="edge-calc-${e.kind}"><td>${Edging.LABELS[e.key]}</td>
        <td>${Edging.KIND_LABELS[e.kind]}</td>
        <td>${expr}</td>
        <td>${fmtNum(comp)}</td><td>${tag}</td></tr>`;
    }).join('');
    const bad = !(d.bw > Edging.EPS) || !(d.bh > Edging.EPS);
    document.getElementById('edge-calc').innerHTML = `
      <table class="edge-calc-table">
        <thead><tr><th>边</th><th>类型</th><th>补偿（−厚度+余量）</th><th>合计 mm</th><th>封边设置</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="edge-calc-sum ${bad ? 'bad' : ''}">
        毛坯宽 = 成品 ${fmtNum(p.width)} + 左(${fmtNum(d.comp.left)}) + 右(${fmtNum(d.comp.right)}) =
        <b>${fmtNum(d.bw)} mm</b>
        &nbsp;&nbsp;|&nbsp;&nbsp;
        毛坯高 = 成品 ${fmtNum(p.height)} + 上(${fmtNum(d.comp.top)}) + 下(${fmtNum(d.comp.bottom)}) =
        <b>${fmtNum(d.bh)} mm</b>
        ${bad ? '<span class="edge-bad-tag">⚠ 毛坯尺寸非正，无法下料（见上表负值边）</span>' : ''}
      </div>`;
  },

  renderSvg() {
    const svg = document.getElementById('edge-svg');
    if (!svg) return;
    const p = this.part;
    const W = +p.width || 1, H = +p.height || 1;
    const pad = 46;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`);
    svg.replaceChildren();
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
      return n;
    };
    const COLOR = { exposed: '#00897b', join: '#1565c0', none: '#999' };
    mk('rect', { x: 0, y: 0, width: W, height: H, class: 'edge-part-rect' });
    const t = mk('text', { x: W / 2, y: H / 2 + 8, class: 'edge-part-name', 'text-anchor': 'middle' });
    t.textContent = `${p.name || p.id} ${fmtNum(W)}×${fmtNum(H)}`;
    const ves = Edging.visualEdges(p, false);
    ves.forEach((e) => {
      const col = COLOR[e.kind];
      let x1, y1, x2, y2, lx, ly, sym;
      const sw = Math.max(2, Math.min(10, +e.thickness * 1.6 || 3));
      if (e.key === 'top') { x1 = 0; y1 = 0; x2 = W; y2 = 0; lx = W / 2; ly = -16; }
      if (e.key === 'bottom') { x1 = 0; y1 = H; x2 = W; y2 = H; lx = W / 2; ly = H + 30; }
      if (e.key === 'left') { x1 = 0; y1 = 0; x2 = 0; y2 = H; lx = -22; ly = H / 2; }
      if (e.key === 'right') { x1 = W; y1 = 0; x2 = W; y2 = H; lx = W + 22; ly = H / 2; }
      mk('line', { x1, y1, x2, y2, stroke: col, 'stroke-width': e.kind === 'none' ? 1.5 : sw,
        'stroke-dasharray': e.kind === 'join' ? '10 6' : 'none', class: 'edge-mark-line' });
      sym = e.kind === 'exposed' ? `外 ${e.thickness || '?'}mm` : e.kind === 'join' ? '拼接' : '—';
      const tt = mk('text', { x: lx, y: ly, class: 'edge-mark-text', fill: col, 'text-anchor': 'middle' });
      tt.textContent = sym;
    });
  },

  /* ================= 封边工序面板 ================= */
  openBatches() {
    const lay = App.layout();
    if (!lay) { toast('请先生成排样方案'); return; }
    this._batchModal();
  },

  /* 当前模式下重算批次（与渲染同源，保证换序基准=当前显示顺序） */
  _currentBatches(lay) {
    const mode = (App.edgingOrder || {}).mode || 'shortFirst';
    return { mode, batches: Edging.batches(lay, mode, (App.edgingOrder || {}).orders) };
  },

  _batchModal() {
    const root = document.getElementById('modal-root');
    const lay = App.layout();
    const render = () => {
      const { mode, batches } = this._currentBatches(lay);
      let segTotal = 0, lenTotal = 0;
      const body = batches.length ? batches.map((b) => {
        segTotal += b.count; lenTotal += b.total;
        const rows = b.segments.map((s, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(s.uid)}</td>
            <td>${esc(s.name || '')}</td>
            <td>${({ top: '上边', right: '右边', bottom: '下边', left: '左边' })[s.edgeVisual]}</td>
            <td>${fmtNum(s.length)}</td>
            <td>${s.sheetId} #${s.instance + 1}</td>
            <td>${mode === 'manual' ? `
              <button class="mini-btn edge-up" data-key="${esc(b.key)}" data-i="${i}"${i === 0 ? ' disabled' : ''}>↑</button>
              <button class="mini-btn edge-down" data-key="${esc(b.key)}" data-i="${i}"${i === b.segments.length - 1 ? ' disabled' : ''}>↓</button>` : ''}</td>
          </tr>`).join('');
        const col = Edging.batchColor(b.key);
        return `
        <div class="edge-batch">
          <h4><span class="edge-batch-dot" style="background:${col}"></span>
            批次 ${b.index}：${esc(b.material)} · ${fmtNum(b.thickness)}mm
            <span class="hint">（${b.count} 段，合计 ${fmtNum(b.total)} mm）</span></h4>
          <table class="edge-batch-table"><thead><tr>
            <th>#</th><th>零件</th><th>名称</th><th>封边方向</th><th>段长 mm</th><th>板材</th>
            ${mode === 'manual' ? '<th>换序</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
        </div>`;
      }).join('') : '<p class="hint">当前方案没有需要封边的边（外露且厚度为正才计入）。</p>';
      root.innerHTML = `
        <div class="modal wide edge-batch-modal">
          <h3>封边工序 — 方案 ${App.active + 1}</h3>
          <div class="edge-mode-bar">
            <label><input type="radio" name="edge-mode" value="shortFirst"${mode === 'shortFirst' ? ' checked' : ''}> 先短边后长边</label>
            <label><input type="radio" name="edge-mode" value="longFirst"${mode === 'longFirst' ? ' checked' : ''}> 先长边后短边</label>
            <label><input type="radio" name="edge-mode" value="manual"${mode === 'manual' ? ' checked' : ''}> 手动换序</label>
            <span class="hint">同材料、同厚度的边合并为一个批次；段长按成品边计算。</span>
          </div>
          <div class="edge-batch-sum">共 <b>${batches.length}</b> 批次 · <b>${segTotal}</b> 段 ·
            封边条总用量 <b>${fmtNum(lenTotal)} mm</b>（${(lenTotal / 1000).toFixed(2)} m）</div>
          <div class="edge-batch-body">${body}</div>
          <div class="foot"><button id="edge-batch-close" class="primary">关闭</button></div>
        </div>`;
      root.querySelectorAll('input[name=edge-mode]').forEach(r => r.addEventListener('change', () => {
        App.edgingOrder = App.edgingOrder || { mode: 'shortFirst', orders: {} };
        App.edgingOrder.mode = r.value;
        // 切到手动模式时，以当前显示顺序初始化该批次序（短边序），后续上/下移在此基础上调整
        if (r.value === 'manual') {
          const cur = this._currentBatches(lay).batches;
          cur.forEach((b) => {
            if (!App.edgingOrder.orders[b.key]) {
              App.edgingOrder.orders[b.key] = b.segments.map(s => s.uid + '|' + s.edgeVisual);
            }
          });
        }
        App.pushHistory();
        render();
      }));
      root.querySelectorAll('.edge-up,.edge-down').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const i = +btn.dataset.i;
        const dir = btn.classList.contains('edge-up') ? -1 : 1;
        App.edgingOrder = App.edgingOrder || { mode: 'shortFirst', orders: {} };
        App.edgingOrder.mode = 'manual';
        // 以【当前正在显示的该批顺序】为基准换序（避免与另一排序混用）
        const shown = (this._currentBatches(lay).batches.find(x => x.key === key) || {}).segments || [];
        const segs = shown.slice();
        const j = i + dir;
        if (j < 0 || j >= segs.length) return;
        [segs[i], segs[j]] = [segs[j], segs[i]];
        App.edgingOrder.orders[key] = segs.map(s => s.uid + '|' + s.edgeVisual);
        App.pushHistory();
        render();
      }));
      document.getElementById('edge-batch-close').addEventListener('click', () => { root.innerHTML = ''; });
      root.addEventListener('click', (e) => { if (e.target === root) root.innerHTML = ''; });
    };
    render();
  },
};
