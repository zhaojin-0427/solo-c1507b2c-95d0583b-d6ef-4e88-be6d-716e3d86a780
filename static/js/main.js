/* 主控：初始化、事件绑定、排样请求、项目存取 */
const Main = {

  init() {
    Canvas.init();
    CutUI.init();
    this.bindTopbar();
    this.bindSettings();
    this.bindDefForms();
    this.bindActions();
    this.bindKeyboard();
    this.loadSample();
    UI.renderSheetsTable();
    UI.renderPartsTable();
    App.resetHistory();
    renderAll();
  },

  /* ---- 示例数据 ---- */
  loadSample() {
    App.settings = { kerf: 3, margin: 5, spacing: 2 };
    App.sheets = [
      { id: 'S1', name: '多层板', width: 2440, height: 1220, grain: 'horizontal', quantity: 2 },
    ];
    App.parts = [
      { id: 'P1', name: '侧板', width: 600, height: 400, quantity: 4, rotatable: true, grain: 'none' },
      { id: 'P2', name: '层板', width: 560, height: 300, quantity: 6, rotatable: true, grain: 'none' },
      { id: 'P3', name: '门板', width: 500, height: 350, quantity: 4, rotatable: false, grain: 'horizontal' },
      { id: 'P4', name: '背板', width: 580, height: 380, quantity: 2, rotatable: true, grain: 'none' },
    ];
    App.layouts = [];
    App.active = 0;
    App.selected = null;
    App.projectId = null;
    this.syncSettingsInputs();
  },

  syncSettingsInputs() {
    document.getElementById('set-kerf').value = App.settings.kerf;
    document.getElementById('set-margin').value = App.settings.margin;
    document.getElementById('set-spacing').value = App.settings.spacing;
  },

  /* ---- 顶栏 ---- */
  bindTopbar() {
    document.getElementById('btn-undo').addEventListener('click', () => App.undo());
    document.getElementById('btn-redo').addEventListener('click', () => App.redo());
    document.getElementById('btn-print').addEventListener('click', () => Print.open());
    document.getElementById('btn-cutplan').addEventListener('click', () => CutUI.toggle());
    document.getElementById('btn-new').addEventListener('click', () => {
      if (!confirm('新建项目将清空当前数据，确定？')) return;
      App.sheets = [{ id: 'S1', name: '原料板', width: 2440, height: 1220, grain: 'none', quantity: 1 }];
      App.parts = [];
      App.layouts = [];
      App.active = 0;
      App.selected = null;
      App.projectId = null;
      document.getElementById('project-name').value = '未命名项目';
      UI.renderSheetsTable();
      UI.renderPartsTable();
      App.resetHistory();
      renderAll();
    });
    document.getElementById('btn-save').addEventListener('click', () => this.saveProject());
    document.getElementById('btn-open').addEventListener('click', () => UI.openLoadModal());
  },

  /* ---- 参数设置 ---- */
  bindSettings() {
    const bind = (id, key) => {
      document.getElementById(id).addEventListener('change', (e) => {
        App.settings[key] = Math.max(0, +e.target.value || 0);
        renderAll();  // 重新校验（间距/留边变化影响违规判定）
      });
    };
    bind('set-kerf', 'kerf');
    bind('set-margin', 'margin');
    bind('set-spacing', 'spacing');
  },

  /* ---- 板材 / 零件定义表单 ---- */
  nextId(prefix, list) {
    let n = 1;
    while (list.some(x => x.id === prefix + n)) n++;
    return prefix + n;
  },

  bindDefForms() {
    document.getElementById('btn-add-sheet').addEventListener('click', () => {
      const g = (id) => document.getElementById(id).value;
      const w = +g('sh-w'), h = +g('sh-h');
      if (!(w > 0) || !(h > 0)) { toast('请填写有效的板材宽高'); return; }
      App.sheets.push({
        id: this.nextId('S', App.sheets),
        name: g('sh-name') || '原料板',
        width: w, height: h,
        quantity: Math.max(1, +g('sh-qty') || 1),
        grain: g('sh-grain'),
      });
      UI.renderSheetsTable();
      this.onStructureChanged(false);
    });
    document.getElementById('btn-add-part').addEventListener('click', () => {
      const g = (id) => document.getElementById(id).value;
      const w = +g('pt-w'), h = +g('pt-h');
      if (!(w > 0) || !(h > 0)) { toast('请填写有效的零件宽高'); return; }
      App.parts.push({
        id: this.nextId('P', App.parts),
        name: g('pt-name') || '零件',
        width: w, height: h,
        quantity: Math.max(1, +g('pt-qty') || 1),
        rotatable: g('pt-rot') === '1',
        grain: g('pt-grain'),
      });
      UI.renderPartsTable();
      this.onStructureChanged(false);
    });
  },

  /* 结构性修改（尺寸/数量/增删）后，旧排样结果失效 */
  onStructureChanged(notify = true) {
    if (App.layouts.length) {
      App.layouts = [];
      App.active = 0;
      App.selected = null;
      App.resetHistory();
      if (notify) toast('定义已修改，排样结果已清空，请重新生成');
    }
    renderAll();
  },

  /* ---- 操作按钮 ---- */
  bindActions() {
    document.getElementById('btn-nest').addEventListener('click', () => this.runNest(false));
    document.getElementById('btn-renest').addEventListener('click', () => this.runNest(true));
    document.getElementById('btn-clear-layout').addEventListener('click', () => {
      if (!App.layouts.length) return;
      App.layouts = [];
      App.active = 0;
      App.selected = null;
      App.resetHistory();
      renderAll();
    });
    document.getElementById('btn-sample').addEventListener('click', () => {
      this.loadSample();
      UI.renderSheetsTable();
      UI.renderPartsTable();
      App.resetHistory();
      renderAll();
      toast('已载入示例数据');
    });

    // 画布工具条
    document.getElementById('tb-zoom-in').addEventListener('click', () => {
      const r = Canvas.svg.getBoundingClientRect();
      Canvas.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.3);
    });
    document.getElementById('tb-zoom-out').addEventListener('click', () => {
      const r = Canvas.svg.getBoundingClientRect();
      Canvas.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.3);
    });
    document.getElementById('tb-fit').addEventListener('click', () => Canvas.zoomFit());
    document.getElementById('tb-rotate').addEventListener('click', () => this.rotateSelected());
    document.getElementById('tb-lock').addEventListener('click', () => this.toggleLock());
    document.getElementById('tb-delete').addEventListener('click', () => this.deleteSelected());
  },

  /* ---- 键盘 ---- */
  bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); App.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); App.redo(); return; }
      if (e.key === 'Escape') {
        App.placeMode = null;
        App.selected = null;
        Canvas.svg.classList.remove('place-mode');
        renderAll();
        return;
      }
      if (e.key === ' ' && App.cutOpen) { e.preventDefault(); CutUI.play(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelected(); return; }
      if (e.key === 'r' || e.key === 'R') { this.rotateSelected(); return; }
      if (e.key === 'l' || e.key === 'L') { this.toggleLock(); return; }
      // 方向键微调
      const found = App.selected && App.findPlacement(App.selected);
      if (found && !found.placement.locked && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        found.placement.x = Math.max(0, found.placement.x + d[0]);
        found.placement.y = Math.max(0, found.placement.y + d[1]);
        App.pushHistory();
        renderAll();
      }
    });
  },

  /* ---- 选中零件操作 ---- */
  rotateSelected() {
    const uid = App.selected;
    const found = uid && App.findPlacement(uid);
    if (!found) { toast('请先选择一个零件'); return; }
    const p = found.placement;
    if (p.locked) { toast('零件已锁定，请先解锁'); return; }
    const pd = App.uidPart(uid);
    if (!pd) return;
    if (pd.grain !== 'none') { toast(`「${pd.name}」有纹理方向要求，不能旋转`); return; }
    if (!pd.rotatable) { toast(`「${pd.name}」设为不可旋转`); return; }
    [p.w, p.h] = [p.h, p.w];
    p.rotated = !p.rotated;
    App.pushHistory();
    renderAll();
  },

  toggleLock() {
    const uid = App.selected;
    const found = uid && App.findPlacement(uid);
    if (!found) { toast('请先选择一个零件'); return; }
    found.placement.locked = !found.placement.locked;
    App.pushHistory();
    renderAll();
    toast(found.placement.locked ? `${uid} 已锁定` : `${uid} 已解锁`);
  },

  deleteSelected() {
    const uid = App.selected;
    const found = uid && App.findPlacement(uid);
    if (!found) return;
    const lay = App.layout();
    const arr = lay.sheets[found.sheetIndex].placements;
    const [p] = arr.splice(arr.findIndex(q => q.uid === uid), 1);
    lay.unplaced.push({ uid: p.uid, partId: p.partId, name: p.name, reason: '手动移除，等待重新放置' });
    App.selected = null;
    App.pushHistory();
    renderAll();
  },

  /* ---- 排样 ---- */
  async runNest(keepLocked) {
    if (!App.sheets.length) { toast('请先定义至少一张原料板'); return; }
    if (!App.parts.length) { toast('请先定义至少一个零件'); return; }
    const payload = {
      settings: App.settings,
      sheets: App.sheets,
      parts: App.parts,
      maxLayouts: 3,
    };
    if (keepLocked) {
      const lay = App.layout();
      if (!lay) { toast('当前没有排样结果，无法保留锁定'); return; }
      const locked = {};
      lay.sheets.forEach((si, idx) => {
        const lps = si.placements.filter(p => p.locked);
        if (lps.length) {
          locked[String(idx)] = lps.map(p => ({
            uid: p.uid, partId: p.partId, name: p.name,
            x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated,
          }));
        }
      });
      if (!Object.keys(locked).length) { toast('没有锁定的零件，请直接生成排样方案'); return; }
      payload.locked = locked;
    }
    document.body.classList.add('busy');
    try {
      const res = await API.nest(payload);
      if (!res.layouts || !res.layouts.length) { toast(res.error || '未找到可行排样'); return; }
      App.layouts = res.layouts;
      App.active = 0;
      App.selected = null;
      App.placeMode = null;
      App.resetHistory();
      renderAll();
      Canvas.zoomFit();
      const best = res.layouts[0];
      toast(`已生成 ${res.layouts.length} 个方案，最优利用率 ${fmtPct(best.stats.utilization)}` +
        (best.stats.unplacedCount ? `，${best.stats.unplacedCount} 件未放置` : ''));
    } catch (err) {
      toast('排样失败：' + err.message);
    } finally {
      document.body.classList.remove('busy');
    }
  },

  /* ---- 项目存取 ---- */
  async saveProject() {
    const name = document.getElementById('project-name').value.trim() || '未命名项目';
    const data = {
      settings: App.settings,
      sheets: App.sheets,
      parts: App.parts,
      layouts: App.layouts,
      active: App.active,
      cutplan: App.cutplan,        // 裁切工序状态（切法覆盖/步骤顺序/进度）随项目保存
      cutStates: App._cutStates,
      cutOpen: App.cutOpen,
    };
    try {
      const res = await API.saveProject(App.projectId, name, data);
      App.projectId = res.id;
      toast(`已保存「${res.name}」`);
    } catch (err) {
      toast('保存失败：' + err.message);
    }
  },

  applyProject(proj) {
    const d = proj.data || {};
    App.settings = Object.assign({ kerf: 3, margin: 5, spacing: 0 }, d.settings);
    App.sheets = d.sheets || [];
    App.parts = d.parts || [];
    App.layouts = d.layouts || [];
    App.active = Math.min(d.active || 0, Math.max(0, App.layouts.length - 1));
    App.selected = null;
    App.placeMode = null;
    App.projectId = proj.id;
    App.cutplan = d.cutplan || null;      // 恢复裁切工序（签名一致时生效）
    App._cutStates = d.cutStates || {};
    App.cutOpen = !!d.cutOpen;
    App.cutplanData = null;
    document.getElementById('project-name').value = proj.name;
    this.syncSettingsInputs();
    UI.renderSheetsTable();
    UI.renderPartsTable();
    App.resetHistory();
    renderAll();
    if (App.layouts.length) Canvas.zoomFit();
  },
};

/* ---- 全局渲染入口 ---- */
function renderAll() {
  App.layouts.forEach(recomputeLayoutStats);  // 本地编辑后统计立即重算
  App.violations = Validate.check();
  Canvas.render();
  UI.renderTabs();
  UI.renderSelection();
  UI.renderViolations();
  UI.renderUnplaced();
  UI.renderStatus();
  UI.updateUndoRedo();
  CutUI.refresh();  // 面板打开时：排样变化 → 旧工序失效并重新分析 + 画布高亮
}

document.addEventListener('DOMContentLoaded', () => Main.init());
