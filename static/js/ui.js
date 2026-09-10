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
      b.innerHTML = `<div class="t">方案 ${i + 1} <span class="s">(${esc(lay.strategy || '')})</span></div>
        <div class="s">利用率 ${fmtPct(st.utilization)} · 废料 ${fmtArea(st.waste)} · ${st.cuts} 刀 · 用板 ${st.usedSheets}/${st.totalSheets}` +
        (st.unplacedCount ? ` · <span class="bad">未放 ${st.unplacedCount}</span>` : '') + `</div>`;
      b.addEventListener('click', () => {
        if (App.active === i) return;
        App.pushHistory();
        App.active = i;
        App.selected = null;
        renderAll();
      });
      box.appendChild(b);
    });
  },

  /* ---- 选中零件面板 ---- */
  renderSelection() {
    const body = document.getElementById('selection-body');
    const uid = App.selected;
    const found = uid && App.findPlacement(uid);
    if (!found) {
      body.innerHTML = '<p class="hint">点击画布中的零件进行选择</p>';
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
      <div class="btns">
        <button id="sel-rotate">⟳ 旋转</button>
        <button id="sel-delete">✕ 移除</button>
      </div>`;
    body.querySelector('#sel-x').addEventListener('change', (e) => {
      App.pushHistory(); p.x = Math.max(0, +e.target.value || 0); renderAll();
    });
    body.querySelector('#sel-y').addEventListener('change', (e) => {
      App.pushHistory(); p.y = Math.max(0, +e.target.value || 0); renderAll();
    });
    body.querySelector('#sel-sheet').addEventListener('change', (e) => {
      const to = +e.target.value;
      if (to === found.sheetIndex) return;
      App.pushHistory();
      const arr = lay.sheets[found.sheetIndex].placements;
      arr.splice(arr.findIndex(q => q.uid === uid), 1);
      lay.sheets[to].placements.push(p);
      renderAll();
    });
    body.querySelector('#sel-lock').addEventListener('change', () => Main.toggleLock());
    body.querySelector('#sel-rotate').addEventListener('click', () => Main.rotateSelected());
    body.querySelector('#sel-delete').addEventListener('click', () => Main.deleteSelected());
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
      li.textContent = m.msg;
      li.title = '点击定位该零件';
      li.addEventListener('click', () => {
        App.selected = m.uid;
        renderAll();
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
      li.innerHTML = `${esc(u.uid)}（${esc(u.name || u.partId)}）<span class="r">${esc(u.reason || '')}</span>`;
      li.title = '点击后在画布目标板材上点击放置';
      li.addEventListener('click', () => {
        App.placeMode = u.uid;
        App.selected = null;
        Canvas.svg.classList.add('place-mode');
        toast(`放置模式：在画布上点击板材放置 ${u.uid}（Esc 取消）`);
      });
      list.appendChild(li);
    });
  },

  /* ---- 状态栏 / 按钮 ---- */
  renderStatus() {
    const el = document.getElementById('st-info');
    const lay = App.layout();
    if (!lay) { el.textContent = '就绪'; return; }
    const st = lay.stats;
    el.textContent = `已放置 ${st.placedCount} 件 · 未放置 ${st.unplacedCount} 件 · ` +
      `利用率 ${fmtPct(st.utilization)} · 废料 ${fmtArea(st.waste)} · 约 ${st.cuts} 刀`;
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
