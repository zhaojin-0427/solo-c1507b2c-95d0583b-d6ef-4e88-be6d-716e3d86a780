/* 拼纹组管理 + 装配预览：
 * - 左侧面板列出拼纹组（组号、横/纵拼、成员数、间隙、容差、同板、完整状态）；
 * - 新建/删除/编辑组；"装配预览"模态框中拖拽成员换位，实时显示每条缝错花量；
 * - 每个零件实例都能加入拼纹组（选中零件面板或预览中选择）。
 */
const GrainUI = {
  dragUid: null,

  init() {
    document.getElementById('btn-grain-preview')
      .addEventListener('click', () => this.openPreview());
    document.getElementById('btn-grain-add')
      .addEventListener('click', () => this.addGroup());
  },

  /* ============ 侧栏面板 ============ */
  renderPanel() {
    const ul = document.getElementById('grain-list');
    if (!ul) return;
    const groups = Grain.groups();
    document.getElementById('grain-count').textContent = groups.length || '';
    ul.innerHTML = '';
    if (!groups.length) {
      ul.innerHTML = '<li class="ok">尚无拼纹组。柜门/抽屉面需要连续对花时新建拼纹组。</li>';
      return;
    }
    const ev = App.violations.grainGroups || [];
    groups.forEach((g) => {
      const st = ev.find(x => x.id === g.id);
      const li = document.createElement('li');
      const cls = !st ? 'info'
        : st.status === 'complete' ? 'ok'
        : st.status === 'failed' ? 'grain-fail' : 'warn';
      li.className = 'grain-li ' + cls;
      const statusTxt = !st ? '' :
        st.status === 'complete' ? `✓ 完整 · 最大偏差 ${fmtNum(st.maxOffset)}mm`
        : st.status === 'failed' ? '✗ 整组未落板'
        : `⚠ 部分落板 ${st.placedCount}/${g.members.length}`;
      li.innerHTML = `
        <div class="gh"><b>${esc(g.id)}</b>
          <span class="gtag">${g.dir === 'h' ? '横拼' : '纵拼'}</span>
          <span class="gtag">${g.members.length} 件</span>
          <span class="gtag${g.sameSheet ? '' : ' off'}">${g.sameSheet ? '同板' : '可跨板'}</span>
          <span class="gr">${statusTxt}</span></div>
        <div class="gm">${g.members.map(esc).join(' → ')}</div>
        <div class="gops">
          <button class="mini-btn" data-act="preview">装配预览</button>
          <button class="mini-btn" data-act="edit">编辑参数</button>
          <button class="mini-btn" data-act="locate">定位</button>
          <button class="mini-btn danger" data-act="del">删除组</button>
        </div>`;
      li.querySelector('[data-act=preview]').addEventListener('click', () => this.openPreview(g.id));
      li.querySelector('[data-act=edit]').addEventListener('click', () => this.editGroup(g.id));
      li.querySelector('[data-act=locate]').addEventListener('click', () => this.locateGroup(g.id));
      li.querySelector('[data-act=del]').addEventListener('click', () => {
        if (!confirm(`删除拼纹组 ${g.id}？成员零件保留，仅解除拼纹关系。`)) return;
        App.grainGroups = App.grainGroups.filter(x => x.id !== g.id);
        App.pushHistory();
        renderAll();
      });
      ul.appendChild(li);
    });
  },

  addGroup() {
    // 用当前选中零件作为首个成员（若已在别的组则先退出）
    const seed = App.selected;
    const g = {
      id: App.nextGroupId(),
      dir: 'h', productGap: 2, tolerance: 2, sameSheet: true,
      members: seed ? [seed] : [],
    };
    if (seed) {
      const old = App.groupOf(seed);
      if (old) old.members = old.members.filter(u => u !== seed);
    }
    App.grainGroups.push(g);
    App.pushHistory();
    renderAll();
    this.editGroup(g.id, true);
  },

  /* 参数编辑小模态框 */
  editGroup(gid, justCreated) {
    const g = App.grainGroups.find(x => x.id === gid);
    if (!g) return;
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal">
        <h3>拼纹组 ${esc(g.id)} 参数</h3>
        <div class="gparam">
          <label>拼合方向
            <select id="gp-dir">
              <option value="h"${g.dir === 'h' ? ' selected' : ''}>横拼（沿水平成排，竖缝）</option>
              <option value="v"${g.dir === 'v' ? ' selected' : ''}>纵拼（沿竖直成列，横缝）</option>
            </select>
          </label>
          <label>成品间隙 (mm)
            <input id="gp-gap" type="number" min="0" step="0.5" value="${g.productGap}">
          </label>
          <label>可接受错花量 (mm)
            <input id="gp-tol" type="number" min="0" step="0.5" value="${g.tolerance}">
          </label>
          <label class="chk"><input id="gp-same" type="checkbox"${g.sameSheet ? ' checked' : ''}>
            必须取自同一张板</label>
          <p class="hint">成员次序（安装次序）在"装配预览"中拖拽调整；
            原料板的纹理重复周期与定位基点在原料板表中设置。</p>
        </div>
        <div class="foot">
          <button id="gp-cancel">取消</button>
          <button id="gp-ok" class="primary">确定</button>
        </div>
      </div>`;
    const snap = JSON.stringify(g);
    const close = (save) => {
      if (!save) Object.assign(g, JSON.parse(snap));
      root.innerHTML = '';
      renderAll();
    };
    document.getElementById('gp-cancel').addEventListener('click', () => close(false));
    root.addEventListener('click', (e) => { if (e.target === root) close(false); });
    document.getElementById('gp-ok').addEventListener('click', () => {
      g.dir = document.getElementById('gp-dir').value;
      g.productGap = Math.max(0, +document.getElementById('gp-gap').value || 0);
      g.tolerance = Math.max(0, +document.getElementById('gp-tol').value || 0);
      g.sameSheet = document.getElementById('gp-same').checked;
      if (justCreated && !g.members.length) {
        // 空组直接保留，可稍后在装配预览中添加；不弹提示打断
      }
      App.pushHistory();
      close(true);
    });
  },

  locateGroup(gid) {
    const g = Grain.groups().find(x => x.id === gid);
    const lay = App.layout();
    if (!lay || !g) return;
    const first = g.members.map(u => Grain.findOnBoard(lay, u)).find(Boolean);
    if (!first) { toast(`拼纹组 ${gid} 当前没有成员落板`); return; }
    if (typeof Defects !== 'undefined') Defects.focusSheet(first.sheetIndex);
    App.selected = g.members.find(u => Grain.findOnBoard(lay, u));
    renderAll();
  },

  /* ============ 装配预览模态框 ============ */
  openPreview(gid) {
    let g;
    if (gid) {
      g = App.grainGroups.find(x => x.id === gid);
    } else {
      g = App.grainGroups[0];
      if (!g) { toast('请先新建拼纹组'); return; }
    }
    if (!g) { toast('拼纹组不存在'); return; }
    this._gid = g.id;
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal wide grain-preview">
        <h3>装配预览 — 拼纹组 <span id="pv-gid"></span>
          <select id="pv-select" class="mini-sel"></select></h3>
        <div class="pv-toolbar">
          <select id="pv-dir">
            <option value="h">横拼（左→右安装）</option>
            <option value="v">纵拼（上→下安装）</option>
          </select>
          <label>成品间隙 <input id="pv-gap" type="number" min="0" step="0.5"></label>
          <label>错花容差 <input id="pv-tol" type="number" min="0" step="0.5"></label>
          <label class="chk"><input id="pv-same" type="checkbox"> 必须同一张板</label>
        </div>
        <div class="pv-body">
          <div class="pv-chain-wrap">
            <div class="pv-hint">拖拽成员卡片可换位（即安装次序）；每条缝实时显示错花量，超限红色高亮。</div>
            <div id="pv-chain"></div>
          </div>
          <div class="pv-pool-wrap">
            <h4>未入组零件实例（点击加入）</h4>
            <input id="pv-filter" class="pv-filter" placeholder="筛选，如 P1 或 门板">
            <ul id="pv-pool"></ul>
          </div>
        </div>
        <div id="pv-seam-summary" class="pv-summary"></div>
        <div class="foot">
          <button id="pv-restore" title="退回最近一次全部合格的摆位">↩ 退回最近合格摆位</button>
          <button id="pv-cancel">关闭</button>
          <button id="pv-ok" class="primary">确定</button>
        </div>
      </div>`;
    this.bindPreview(g);
  },

  bindPreview(g) {
    const root = document.getElementById('modal-root');
    document.getElementById('pv-gid').textContent = g.id;
    // 组切换
    const sel = document.getElementById('pv-select');
    App.grainGroups.forEach(x => {
      const o = document.createElement('option');
      o.value = x.id; o.textContent = x.id;
      if (x.id === g.id) o.selected = true;
      sel.appendChild(o);
    });
    const ng = document.createElement('option');
    ng.value = '__new__'; ng.textContent = '＋ 新建组';
    sel.appendChild(ng);
    sel.addEventListener('change', () => {
      if (sel.value === '__new__') { this.addGroup(); this.openPreview(App.grainGroups[App.grainGroups.length - 1].id); }
      else this.openPreview(sel.value);
    });
    document.getElementById('pv-dir').value = g.dir;
    document.getElementById('pv-gap').value = g.productGap;
    document.getElementById('pv-tol').value = g.tolerance;
    document.getElementById('pv-same').checked = g.sameSheet;

    const commitParams = () => {
      g.dir = document.getElementById('pv-dir').value;
      g.productGap = Math.max(0, +document.getElementById('pv-gap').value || 0);
      g.tolerance = Math.max(0, +document.getElementById('pv-tol').value || 0);
      g.sameSheet = document.getElementById('pv-same').checked;
      this.renderPreview();
    };
    ['pv-dir', 'pv-gap', 'pv-tol', 'pv-same'].forEach(id =>
      document.getElementById(id).addEventListener('change', commitParams));

    document.getElementById('pv-filter').addEventListener('input', () => this.renderPool());
    document.getElementById('pv-ok').addEventListener('click', () => {
      App.pushHistory();
      root.innerHTML = '';
      renderAll();
    });
    document.getElementById('pv-cancel').addEventListener('click', () => { root.innerHTML = ''; renderAll(); });
    root.addEventListener('click', (e) => { if (e.target === root) { root.innerHTML = ''; renderAll(); } });
    document.getElementById('pv-restore').addEventListener('click', () => {
      const lay = App.layout();
      if (!lay) return;
      if (!Grain.hasCheckpoint(lay)) { toast('还没有"全部合格"的摆位记录'); return; }
      Grain.restoreCheckpoint(lay);
      App.pushHistory();
      this.renderPreview();
      renderAll();
      toast('已退回最近一次全部合格的摆位');
    });
    this.renderPreview();
  },

  /* 装配链渲染（成员卡 + 缝标签） */
  renderPreview() {
    const g = App.grainGroups.find(x => x.id === this._gid);
    if (!g) return;
    const chain = document.getElementById('pv-chain');
    chain.className = 'pv-chain ' + (g.dir === 'h' ? 'dir-h' : 'dir-v');
    chain.innerHTML = '';
    const lay = App.layout();
    const axis = g.dir === 'h' ? 'x' : 'y';

    g.members.forEach((uid, mi) => {
      if (mi > 0) chain.appendChild(this.seamCard(g, mi - 1, lay, axis));
      chain.appendChild(this.memberCard(g, uid, mi, lay));
    });
    if (!g.members.length) {
      chain.innerHTML = '<p class="hint">空组：从右侧点击零件实例加入（同一实例只能属于一个组）。</p>';
    }
    this.renderPool();
    this.renderSummary(g, lay);
  },

  memberCard(g, uid, mi, lay) {
    const pd = App.uidPart(uid);
    const hit = lay ? Grain.findOnBoard(lay, uid) : null;
    const el = document.createElement('div');
    el.className = 'pv-member' + (hit ? '' : ' offboard') + (App.selected === uid ? ' selected' : '');
    el.draggable = true;
    el.dataset.uid = uid;
    el.innerHTML = `
      <div class="pv-no">${mi + 1}</div>
      <div class="pv-info">
        <b>${esc(uid)}</b> ${pd ? esc(pd.name) : ''}
        <div class="pv-sub">${pd ? `${fmtNum(pd.width)}×${fmtNum(pd.height)}mm · ` : ''}${
          hit ? `${esc(lay.sheets[hit.sheetIndex].sheetId)} #${lay.sheets[hit.sheetIndex].instance + 1}` : '未放置'}</div>
      </div>
      <button class="pv-x" title="移出拼纹组">✕</button>`;
    el.querySelector('.pv-x').addEventListener('click', () => {
      g.members = g.members.filter(u => u !== uid);
      App.pushHistory();
      this.renderPreview();
    });
    el.addEventListener('dragstart', () => { this.dragUid = uid; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); this.dragUid = null; });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragUid;
      if (!from || from === uid) return;
      const arr = g.members;
      const fi = arr.indexOf(from), ti = arr.indexOf(uid);
      arr.splice(fi, 1);
      arr.splice(arr.indexOf(uid), 0, from);
      App.pushHistory();
      this.renderPreview();
    });
    return el;
  },

  seamCard(g, k, lay, axis) {
    const uA = g.members[k], uB = g.members[k + 1];
    const el = document.createElement('div');
    el.className = 'pv-seam';
    let txt = '—', cls = 'seam-unknown', title = '至少一方未放置';
    if (lay) {
      const a = Grain.findOnBoard(lay, uA), b = Grain.findOnBoard(lay, uB);
      if (a && b) {
        const seam = Grain.evaluateSeam(a.placement, b.placement, axis, g.productGap,
          Grain.sheetInfo(lay, a.sheetIndex), Grain.sheetInfo(lay, b.sheetIndex));
        const ok = Grain.seamQualified(seam, g.tolerance);
        cls = ok ? 'seam-ok' : (seam.status === 'unknown' ? 'seam-unknown' : 'seam-bad');
        txt = seam.status === 'unknown' ? '相位?' : `Δ${fmtNum(seam.offset)}`;
        title = seam.reason || (ok ? '错花量合格' : `错花量超过 ${fmtNum(g.tolerance)}mm`);
        if (a.sheetIndex !== b.sheetIndex) title += '（跨板）';
      }
    }
    el.classList.add(cls);
    el.title = title;
    el.textContent = txt;
    return el;
  },

  renderPool() {
    const g = App.grainGroups.find(x => x.id === this._gid);
    const ul = document.getElementById('pv-pool');
    if (!ul || !g) return;
    const filter = (document.getElementById('pv-filter').value || '').trim().toLowerCase();
    // 其他组占用的 uid 不可再选
    const taken = new Set();
    App.grainGroups.forEach(x => { if (x.id !== g.id) x.members.forEach(u => taken.add(u)); });
    ul.innerHTML = '';
    App.allInstanceUids().forEach((uid) => {
      if (g.members.includes(uid) || taken.has(uid)) return;
      const pd = App.uidPart(uid);
      const name = (pd ? pd.name : '') + ' ' + uid;
      if (filter && !name.toLowerCase().includes(filter)) return;
      const li = document.createElement('li');
      li.textContent = uid + (pd ? ` · ${pd.name}` : '');
      li.title = '点击加入到末尾';
      li.addEventListener('click', () => {
        g.members.push(uid);
        App.pushHistory();
        this.renderPreview();
      });
      ul.appendChild(li);
    });
    if (!ul.children.length) {
      ul.innerHTML = '<li class="hint">没有可加入的实例（都已在其它拼纹组或零件表为空）</li>';
    }
  },

  renderSummary(g, lay) {
    const box = document.getElementById('pv-seam-summary');
    if (!box) return;
    const ev = lay ? Grain.evaluate(lay) : null;
    const gv = ev && ev.groups.find(x => x.id === g.id);
    if (!gv) { box.innerHTML = '<span class="hint">生成排样后显示接缝评估</span>'; return; }
    const bad = gv.badSeamCount, unk = gv.unknownSeamCount;
    box.innerHTML = `
      <span class="${gv.status === 'complete' ? 'pv-ok' : 'pv-bad'}">
        ${gv.status === 'complete' ? '✓ 整组完整、全部接缝合格'
          : gv.status === 'failed' ? '✗ 整组未落板'
          : `⚠ 部分落板 ${gv.placedCount}/${g.members.length}`}
      </span>
      最大接缝偏差 <b>${fmtNum(gv.maxOffset)}mm</b> · 容差 ${fmtNum(g.tolerance)}mm
      ${bad ? ` · <span class="pv-bad">超限缝 ${bad} 条</span>` : ''}
      ${unk ? ` · <span class="pv-warn">相位未知缝 ${unk} 条</span>` : ''}
      ${gv.sameSheetViolation ? ' · <span class="pv-bad">违反同板要求</span>' : ''}`;
  },
};
