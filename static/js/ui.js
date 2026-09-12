/* 侧栏表格、方案标签、选中面板、违规/未放置列表、项目模态框 */
const UI = {

  /* ---- 定义表格（原料板 / 零件） ---- */
  renderSheetsTable() {
    const tb = document.querySelector('#sheets-table tbody');
    tb.innerHTML = '';
    App.sheets.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" data-k="name" value="${esc(s.name)}"></td>
        <td><input type="number" data-k="width" value="${s.width}" min="1" style="width:58px"></td>
        <td><input type="number" data-k="height" value="${s.height}" min="1" style="width:58px"></td>
        <td><input type="number" data-k="quantity" value="${s.quantity}" min="1" style="width:44px"></td>
        <td><select data-k="grain">
          <option value="none"${s.grain === 'none' ? ' selected' : ''}>无</option>
          <option value="horizontal"${s.grain === 'horizontal' ? ' selected' : ''}>横向</option>
          <option value="vertical"${s.grain === 'vertical' ? ' selected' : ''}>纵向</option>
        </select></td>
        <td><button class="del-btn" title="删除">✕</button></td>`;
      tr.querySelectorAll('input,select').forEach(inp => {
        inp.addEventListener('change', () => {
          const k = inp.dataset.k;
          s[k] = (k === 'name' || k === 'grain') ? inp.value : Math.max(1, +inp.value || 1);
          if (k !== 'name' && k !== 'grain') Main.onStructureChanged();
          else renderAll();
        });
      });
      tr.querySelector('.del-btn').addEventListener('click', () => {
        App.sheets.splice(i, 1);
        Main.onStructureChanged();
      });
      tb.appendChild(tr);
    });
  },

  renderPartsTable() {
    const tb = document.querySelector('#parts-table tbody');
    tb.innerHTML = '';
    App.parts.forEach((p, i) => {
      const tr = document.createElement('tr');
      const faceTxt = { any: '任意', front: '正面', back: '反面', both: '双面' }[p.faceReq || 'any'] || '任意';
      const tol = (+p.allowGrade || 0)
        ? `≤${p.allowGrade}级${(p.allowZones || []).length ? '·圈区' : ''}` : '无';
      tr.innerHTML = `
        <td><input type="text" data-k="name" value="${esc(p.name)}"></td>
        <td><input type="number" data-k="width" value="${p.width}" min="1" style="width:52px"></td>
        <td><input type="number" data-k="height" value="${p.height}" min="1" style="width:52px"></td>
        <td><input type="number" data-k="quantity" value="${p.quantity}" min="1" style="width:40px"></td>
        <td style="text-align:center"><input type="checkbox" data-k="rotatable"${p.rotatable ? ' checked' : ''}></td>
        <td><select data-k="grain">
          <option value="none"${p.grain === 'none' ? ' selected' : ''}>无</option>
          <option value="horizontal"${p.grain === 'horizontal' ? ' selected' : ''}>横向</option>
          <option value="vertical"${p.grain === 'vertical' ? ' selected' : ''}>纵向</option>
        </select></td>
        <td><button class="tol-btn" title="正反面要求 / 允许缺陷等级 / 容许区">${faceTxt}·${tol}</button></td>
        <td><button class="del-btn" title="删除">✕</button></td>`;
      tr.querySelectorAll('input,select').forEach(inp => {
        inp.addEventListener('change', () => {
          const k = inp.dataset.k;
          if (k === 'rotatable') p[k] = inp.checked;
          else if (k === 'name' || k === 'grain') p[k] = inp.value;
          else p[k] = Math.max(1, +inp.value || 1);
          if (k === 'width' || k === 'height' || k === 'quantity') Main.onStructureChanged();
          else renderAll();
        });
      });
      tr.querySelector('.tol-btn').addEventListener('click', () => PartTol.openModal(p, i));
      tr.querySelector('.del-btn').addEventListener('click', () => {
        App.parts.splice(i, 1);
        Main.onStructureChanged();
      });
      tb.appendChild(tr);
    });
  },

  /* ---- 方案对比标签 ---- */
  renderTabs() {
    const box = document.getElementById('layout-tabs');
    box.innerHTML = '';
    if (!App.layouts.length) {
      box.innerHTML = '<span class="hint">尚未生成排样方案 — 请在左侧定义板材与零件后点击"生成排样方案"</span>';
      return;
    }
    App.layouts.forEach((lay, i) => {
      const st = lay.stats;
      const b = document.createElement('button');
      b.className = 'layout-tab' + (i === App.active ? ' active' : '');
      if (lay.empty) {
        b.innerHTML = `<div class="t">待排样</div><div class="s">尚未生成排样方案，板面缺陷已可登记，生成排样后自动避让</div>`;
      } else {
      const badQ = st.qualifiedCount != null && st.qualifiedCount < st.placedCount;
      b.innerHTML = `<div class="t">方案 ${i + 1} <span class="s">(${esc(lay.strategy || '')})</span></div>
        <div class="s">合格 ${st.qualifiedCount != null ? st.qualifiedCount : st.placedCount}/${st.placedCount} · 利用率 ${fmtPct(st.utilization)} · 用板 ${st.usedSheets}/${st.totalSheets} · 避让碎料 ${fmtArea(st.defectScrap || 0)} · ${st.cuts} 刀` +
        (st.unplacedCount ? ` · <span class="bad">未放 ${st.unplacedCount}</span>` : '') +
        (badQ ? ` · <span class="bad">冲突 ${st.defectConflictCount}</span>` : '') + `</div>`;
      }
      b.addEventListener('click', () => {
        if (App.active === i) return;
        App.active = i;
        App.selected = null;
        App.pushHistory();
        renderAll();
      });
      box.appendChild(b);
    });
  },

  /* ---- 选中面板（零件或板面缺陷） ---- */
  renderSelection() {
    const body = document.getElementById('selection-body');
    // 优先显示选中的缺陷
    if (App.selectedDefect) {
      const sel = App.selectedDefect;
      const f = App.findDefect(sel.key, sel.id);
      if (!f.defect) { App.selectedDefect = null; body.innerHTML = '<p class="hint">点击画布中的零件进行选择</p>'; return; }
      const d = f.defect;
      const [sheetId, inst] = sel.key.split('#');
      const lay = App.layout();
      const si = lay && lay.sheets[+inst] && lay.sheets[+inst].sheetId === sheetId
        ? lay.sheets[+inst] : null;
      const affected = App.violations.dmap.get(sel.key + ':' + d.id) || [];
      body.innerHTML = `
        <div class="row"><label>缺陷</label><b>${esc(d.id)}</b></div>
        <div class="row"><label>板材</label><span>${esc(sheetId)} #${(+inst) + 1}</span></div>
        <div class="row"><label>类型</label><select id="df-type">
          <option value="knot"${d.type === 'knot' ? ' selected' : ''}>节疤</option>
          <option value="crack"${d.type === 'crack' ? ' selected' : ''}>裂纹</option>
          <option value="scratch"${d.type === 'scratch' ? ' selected' : ''}>划痕</option>
        </select></div>
        <div class="row"><label>等级</label><select id="df-grade">
          <option value="1"${d.grade === 1 ? ' selected' : ''}>1 级（轻微）</option>
          <option value="2"${d.grade === 2 ? ' selected' : ''}>2 级（中等）</option>
          <option value="3"${d.grade === 3 ? ' selected' : ''}>3 级（严重）</option>
        </select></div>
        <div class="row"><label>影响面</label><select id="df-face">
          <option value="front"${d.face === 'front' ? ' selected' : ''}>正面</option>
          <option value="back"${d.face === 'back' ? ' selected' : ''}>反面</option>
          <option value="both"${d.face === 'both' ? ' selected' : ''}>双面（贯穿）</option>
        </select></div>
        <div class="row"><label>外扩量</label><input id="df-clear" type="number" min="0" step="1" value="${d.clearance}"> mm</div>
        <div class="row"><label>形状</label><span>${d.shape === 'rect' ? '矩形（拖对角点调整）' : '多边形（拖顶点调整）'}</span></div>
        <div class="btns">
          <button id="df-delete" class="danger-btn">✕ 删除缺陷</button>
        </div>
        ${affected.length ? `<p class="hint bad-hint">受影响零件（点击定位）：<br>${affected.map(u =>
          `<a class="loc-part" data-uid="${esc(u)}">${esc(u)}</a>`).join('、')}</p>`
          : '<p class="hint">当前没有零件侵入该缺陷的避让范围。</p>'}`;
      const commit = () => { App.pushHistory(); renderAll(); };
      body.querySelector('#df-type').addEventListener('change', e => { d.type = e.target.value; Defects._lastType = d.type; commit(); });
      body.querySelector('#df-grade').addEventListener('change', e => { d.grade = +e.target.value; Defects._lastGrade = d.grade; commit(); });
      body.querySelector('#df-face').addEventListener('change', e => { d.face = e.target.value; Defects._lastFace = d.face; commit(); });
      body.querySelector('#df-clear').addEventListener('change', e => {
        d.clearance = Math.max(0, +e.target.value || 0); Defects._lastClearance = d.clearance; commit();
      });
      body.querySelector('#df-delete').addEventListener('click', () => Defects.deleteSelected());
      body.querySelectorAll('.loc-part').forEach(a => a.addEventListener('click', () => {
        App.selected = a.dataset.uid; App.selectedDefect = null;
        UI.locateUid(a.dataset.uid);
      }));
      return;
    }

    const uid = App.selected;
    const found = uid && App.findPlacement(uid);
    if (!found) {
      body.innerHTML = '<p class="hint">点击画布中的零件进行选择；缺陷工具激活时点击缺陷可编辑属性</p>';
      return;
    }
    const p = found.placement;
    const pd = App.uidPart(uid);
    const lay = App.layout();
    const sheetOpts = lay.sheets.map((si, i) =>
      `<option value="${i}"${i === found.sheetIndex ? ' selected' : ''}>${esc(si.sheetId)} ${esc(si.name || '')} #${si.instance + 1}</option>`).join('');
    body.innerHTML = `
      <div class="row"><label>零件</label><b>${esc(uid)}</b>&nbsp;${pd ? esc(pd.name) : ''}</div>
      <div class="row"><label>尺寸</label><span>${fmtNum(p.w)} × ${fmtNum(p.h)} mm${p.rotated ? '（已旋转）' : ''}</span></div>
      <div class="row"><label>位置 X</label><input id="sel-x" type="number" step="1" value="${p.x}"></div>
      <div class="row"><label>位置 Y</label><input id="sel-y" type="number" step="1" value="${p.y}"></div>
      <div class="row"><label>所在板</label><select id="sel-sheet">${sheetOpts}</select></div>
      <div class="row"><label>锁定</label><input id="sel-lock" type="checkbox"${p.locked ? ' checked' : ''}></div>
      ${pd ? `<div class="row"><label>容缺</label><span class="hint">${
        { any: '正反面均可', front: '正面须无缺陷', back: '反面须无缺陷', both: '双面均须无缺陷' }[pd.faceReq || 'any']
      } · ${(+pd.allowGrade || 0) ? `容许≤${pd.allowGrade}级` : '不容许缺陷'} · 容许区 ${(pd.allowZones || []).length} 处
      &nbsp;<button id="sel-tol" class="mini-btn">编辑</button></span></div>` : ''}
      <div class="btns">
        <button id="sel-rotate">⟳ 旋转</button>
        <button id="sel-delete">✕ 移除</button>
      </div>`;
    body.querySelector('#sel-x').addEventListener('change', (e) => {
      p.x = Math.max(0, +e.target.value || 0);
      App.pushHistory(); renderAll();
    });
    body.querySelector('#sel-y').addEventListener('change', (e) => {
      p.y = Math.max(0, +e.target.value || 0);
      App.pushHistory(); renderAll();
    });
    body.querySelector('#sel-sheet').addEventListener('change', (e) => {
      const to = +e.target.value;
      if (to === found.sheetIndex) return;
      const arr = lay.sheets[found.sheetIndex].placements;
      arr.splice(arr.findIndex(q => q.uid === uid), 1);
      lay.sheets[to].placements.push(p);
      App.pushHistory();
      renderAll();
    });
    body.querySelector('#sel-lock').addEventListener('change', () => Main.toggleLock());
    body.querySelector('#sel-rotate').addEventListener('click', () => Main.rotateSelected());
    body.querySelector('#sel-delete').addEventListener('click', () => Main.deleteSelected());
    if (pd && body.querySelector('#sel-tol')) {
      body.querySelector('#sel-tol').addEventListener('click', () => PartTol.openModal(pd));
    }
  },

  /* ---- 定位：切换到目标板材并缩放定位，选中零件/缺陷 ---- */
  focusSheet(sheetIdx) {
    if (typeof Defects !== 'undefined') Defects.focusSheet(sheetIdx);
  },
  locateUid(uid) {
    const found = App.findPlacement(uid);
    if (!found) { toast('该零件当前未放置在板材上'); return; }
    if (App.active !== undefined && App.layouts.length) {
      // 保持在当前方案；切换到零件所在板
    }
    App.selected = uid;
    this.focusSheet(found.sheetIndex);
    renderAll();
  },
  locateDefect(loc) {
    // loc: {type:'defect'|'partdefect', key, id, sheetIndex, uid?}
    const lay = App.layout();
    if (!lay || !lay.sheets[loc.sheetIndex]) return;
    this.focusSheet(loc.sheetIndex);
    App.defectMode = null;
    if (typeof Canvas !== 'undefined') Canvas.svg.classList.remove('defect-mode');
    App.selectedDefect = { key: loc.key, id: loc.id };
    App.selected = loc.uid || null;
    renderAll();
  },

  /* ---- 违规列表 ---- */
  renderViolations() {
    const list = document.getElementById('violations-list');
    const msgs = App.violations.messages;
    document.getElementById('violation-count').textContent = msgs.length || '';
    list.innerHTML = '';
    if (!msgs.length) {
      list.innerHTML = '<li class="ok">无违规</li>';
      return;
    }
    msgs.forEach((m) => {
      const li = document.createElement('li');
      if (m.code === 'spacing') li.className = 'warn';
      if (m.code === 'grain' || m.code === 'size' || m.code === 'nodef') li.className = 'info';
      if (m.code === 'defect' || m.code === 'defout') li.className = 'defect-msg';
      li.textContent = m.msg;
      li.title = '点击定位';
      li.addEventListener('click', () => {
        if (m.loc && (m.loc.type === 'defect' || m.loc.type === 'partdefect')) {
          UI.locateDefect(m.loc);
        } else if (m.loc && m.loc.sheetIndex != null) {
          App.selected = m.uid;
          UI.focusSheet(m.loc.sheetIndex);
          renderAll();
        } else if (m.uid) {
          App.selected = m.uid;
          renderAll();
        }
      });
      list.appendChild(li);
    });
  },

  /* ---- 未放置列表 ---- */
  renderUnplaced() {
    const list = document.getElementById('unplaced-list');
    const lay = App.layout();
    const ups = lay ? lay.unplaced : [];
    document.getElementById('unplaced-count').textContent = ups.length || '';
    list.innerHTML = '';
    if (!lay) {
      list.innerHTML = '<li class="ok">尚未排样</li>';
      return;
    }
    if (!ups.length) {
      list.innerHTML = '<li class="ok">全部已放置</li>';
      return;
    }
    ups.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'info';
      let chips = '';
      (u.conflicts || []).forEach((c) => {
        const ds = (c.defects || []).map(esc).join('、');
        chips += `<button class="conflict-chip" data-sheet="${c.sheetIndex}" data-key="${esc(App.defectKey(c.sheetId, c.instance))}"
           title="定位到冲突板材与缺陷">📍 ${esc(c.sheetId)} #${c.instance + 1}：${ds}</button>`;
      });
      li.innerHTML = `${esc(u.uid)}（${esc(u.name || u.partId)}）<span class="r">${esc(u.reason || '')}</span>${chips}`;
      li.title = '点击后在画布目标板材上点击放置';
      li.addEventListener('click', (e) => {
        const chip = e.target.closest('.conflict-chip');
        if (chip) {
          // 定位到冲突板材；若后端给出了具体缺陷 id 则选中该缺陷
          const si = +chip.dataset.sheet;
          UI.focusSheet(si);
          const key = chip.dataset.key;
          const firstDef = (App.defects[key] || [])[0];
          App.selectedDefect = firstDef ? { key, id: firstDef.id } : null;
          App.selected = null;
          renderAll();
          return;
        }
        App.placeMode = u.uid;
        App.selected = null;
        Canvas.svg.classList.add('place-mode');
        toast(`放置模式：在画布上点击板材放置 ${u.uid}（Esc 取消）`);
      });
      list.appendChild(li);
    });
  },

  /* ---- 缺陷清单（按板材实例分组，点击定位） ---- */
  renderDefectsList() {
    const list = document.getElementById('defects-list');
    const badge = document.getElementById('defect-count');
    if (!list) return;
    const lay = App.layout();
    const keys = Object.keys(App.defects).filter(k => (App.defects[k] || []).length);
    let total = 0;
    keys.forEach(k => total += App.defects[k].length);
    badge.textContent = total || '';
    list.innerHTML = '';
    // 工具按钮激活态
    const br = document.getElementById('btn-d-rect'), bp = document.getElementById('btn-d-poly');
    if (br) br.classList.toggle('active', App.defectMode === 'rect');
    if (bp) bp.classList.toggle('active', App.defectMode === 'poly');
    if (!total) {
      list.innerHTML = '<li class="ok">尚无板面缺陷</li>';
      return;
    }
    if (!lay) {
      list.innerHTML = '<li class="hint">缺陷已登记，生成排样后将自动避让</li>';
      return;
    }
    keys.forEach((key) => {
      const [sheetId, inst] = [key.split('#')[0], +key.split('#')[1]];
      const sheetIdx = lay.sheets.findIndex(s => s.sheetId === sheetId && s.instance === inst);
      App.defects[key].forEach((d) => {
        const li = document.createElement('li');
        li.className = 'defect-li type-' + d.type;
        const affected = App.violations.dmap.get(key + ':' + d.id) || [];
        li.innerHTML = `<b>${esc(d.id)}</b> <span class="r">${esc(sheetId)} #${inst + 1} · ` +
          `${esc(Defects.TYPES[d.type] || d.type)} ${d.grade}级 · ${esc(Defects.FACES[d.face] || d.face)} · 外扩${fmtNum(d.clearance)}` +
          (affected.length ? ` · <span class="bad">影响 ${affected.length} 件</span>` : '') + '</span>';
        li.title = '点击定位到该板材与缺陷';
        li.addEventListener('click', () => {
          if (sheetIdx < 0) return;
          UI.locateDefect({ type: 'defect', key, id: d.id, sheetIndex: sheetIdx });
        });
        list.appendChild(li);
      });
    });
  },

  /* ---- 状态栏 / 按钮 ---- */
  renderStatus() {
    const el = document.getElementById('st-info');
    const lay = App.layout();
    if (!lay) { el.textContent = '就绪'; return; }
    const st = lay.stats;
    el.textContent = `已放置 ${st.placedCount} 件（合格 ${st.qualifiedCount != null ? st.qualifiedCount : st.placedCount}）· 未放置 ${st.unplacedCount} 件 · ` +
      `利用率 ${fmtPct(st.utilization)} · 避让碎料 ${fmtArea(st.defectScrap || 0)} · 约 ${st.cuts} 刀`;
  },

  updateUndoRedo() {
    document.getElementById('btn-undo').disabled = App.hIndex <= 0;
    document.getElementById('btn-redo').disabled = App.hIndex >= App.history.length - 1;
  },

  /* ---- 项目打开模态框 ---- */
  async openLoadModal() {
    const root = document.getElementById('modal-root');
    let rows = [];
    try { rows = await API.listProjects(); }
    catch (err) { toast('读取项目列表失败：' + err.message); return; }
    root.innerHTML = `
      <div class="modal">
        <h3>打开项目</h3>
        <div class="list">
          ${rows.length ? rows.map(r => `
            <div class="proj-row" data-id="${r.id}">
              <span class="name">${esc(r.name)}</span>
              <span class="time">${new Date(r.updated_at * 1000).toLocaleString()}</span>
              <button class="open">打开</button>
              <button class="del">删除</button>
            </div>`).join('') : '<p class="hint">暂无已保存的项目</p>'}
        </div>
        <div class="foot"><button id="modal-close">关闭</button></div>
      </div>`;
    root.querySelector('#modal-close').addEventListener('click', () => { root.innerHTML = ''; });
    root.addEventListener('click', (e) => { if (e.target === root) root.innerHTML = ''; });
    root.querySelectorAll('.proj-row').forEach(row => {
      const id = +row.dataset.id;
      row.querySelector('.open').addEventListener('click', async () => {
        try {
          const proj = await API.loadProject(id);
          Main.applyProject(proj);
          root.innerHTML = '';
          toast(`已打开「${proj.name}」`);
        } catch (err) { toast('打开失败：' + err.message); }
      });
      row.querySelector('.del').addEventListener('click', async () => {
        if (!confirm('确定删除该项目？')) return;
        try {
          await API.deleteProject(id);
          row.remove();
        } catch (err) { toast('删除失败：' + err.message); }
      });
    });
  },
};
