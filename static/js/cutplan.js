/* 裁切工序演练：把当前排样拆成可执行的贯通切割树（guillotine cut tree）。
 *
 * 模型约定：
 * - 坐标为板材绝对坐标（含板边留量区），原点在板材左上角，单位 mm；
 * - 一刀 = 在当前子板上的一条贯通直线，方向为竖切(v)或横切(h)；
 * - 切线位置 at 为锯片左/上缘，锯缝带 [at, at+kerf] 被锯掉（计入损耗）；
 * - 切割后：左/上子板到 at 为止，右/下子板从 at+kerf 开始（钳制在板内）；
 * - 零件不得跨越锯缝带；子板与某零件完全一致 → 产出该零件；
 *   无零件的子板 → 余料（短边 ≥ REUSE_MIN 视为可复用）；
 * - 板上零件 >1 且找不到任何贯通切线 → 阻塞区域，剩余裁切归入人工处理。
 *
 * 工序状态（切法覆盖、步骤顺序、播放进度）挂在 App.cutplan 上并随项目保存；
 * 排样几何或锯缝变化 → 签名变化 → 旧工序自动失效并重新分析。
 * 本模块不操作 DOM，便于在 Node 中回归测试；界面见 cutui.js。
 */
const CutPlan = {
  EPS: 1e-6,
  REUSE_MIN: 100,        // 可复用余料的最小短边 (mm)
  MAX_CACHED_STATES: 12, // 各排样签名的工序状态缓存上限（切换方案不丢自定义）

  _r3(v) { return Math.round(v * 1000) / 1000; },
  boardKey(b) { return [b.x, b.y, b.w, b.h].map(v => this._r3(v)).join(','); },

  /* 候选切线：枚举当前子板上所有不切断零件的贯通直线。
     位置取自零件边（分离/修边）与零件边-锯缝（修边/分离）。
     返回 [{dir, at, left, right, trim, wasteSide}]，竖切优先、位置升序。 */
  candidates(board, parts, kerf) {
    const EPS = this.EPS;
    const out = [];
    const seen = new Set();
    const pos = [];
    for (const p of parts) {
      pos.push({ dir: 'v', at: p.x + p.w }, { dir: 'v', at: p.x - kerf },
               { dir: 'h', at: p.y + p.h }, { dir: 'h', at: p.y - kerf });
    }
    pos.sort((a, b) => (a.dir === b.dir ? a.at - b.at : (a.dir === 'v' ? -1 : 1)));
    for (const c of pos) {
      const at = this._r3(c.at);
      const key = c.dir + '@' + at;
      if (seen.has(key)) continue;
      seen.add(key);
      // 锯缝带必须与当前子板相交
      if (c.dir === 'v') {
        if (at >= board.x + board.w - EPS || at + kerf <= board.x + EPS) continue;
      } else if (at >= board.y + board.h - EPS || at + kerf <= board.y + EPS) continue;
      // 零件不得跨越锯缝带
      let left = 0, right = 0, ok = true;
      for (const p of parts) {
        const lo = c.dir === 'v' ? p.x : p.y;
        const hi = c.dir === 'v' ? p.x + p.w : p.y + p.h;
        if (hi <= at + EPS) left++;
        else if (lo >= at + kerf - EPS) right++;
        else { ok = false; break; }
      }
      if (!ok) continue;
      const trim = left === 0 || right === 0;
      out.push({
        dir: c.dir, at, left, right, trim,
        wasteSide: trim ? (left === 0 ? (c.dir === 'v' ? '左' : '上')
                                     : (c.dir === 'v' ? '右' : '下')) : null,
      });
    }
    return out;
  },

  /* 执行一刀 → [左/上子板, 右/下子板, 锯缝损耗面积]（子板可为 null） */
  applyCut(board, cut, kerf) {
    const EPS = this.EPS;
    let a = null, b = null, loss = 0;
    if (cut.dir === 'v') {
      const x1 = board.x + board.w;
      if (cut.at - board.x > EPS) a = { x: board.x, y: board.y, w: cut.at - board.x, h: board.h };
      const rx = Math.max(cut.at + kerf, board.x);
      if (x1 - rx > EPS) b = { x: rx, y: board.y, w: x1 - rx, h: board.h };
      loss = (Math.min(cut.at + kerf, x1) - Math.max(cut.at, board.x)) * board.h;
    } else {
      const y1 = board.y + board.h;
      if (cut.at - board.y > EPS) a = { x: board.x, y: board.y, w: board.w, h: cut.at - board.y };
      const ry = Math.max(cut.at + kerf, board.y);
      if (y1 - ry > EPS) b = { x: board.x, y: ry, w: board.w, h: y1 - ry };
      loss = (Math.min(cut.at + kerf, y1) - Math.max(cut.at, board.y)) * board.w;
    }
    return [a, b, Math.max(0, loss)];
  },

  /* 分析一张板 → { steps, remnants, blocked, manual, producerOf, partStep, kerfLoss } */
  analyzeSheet(W, H, placements, kerf, overrides) {
    const partsByUid = {};
    (placements || []).forEach(p => { partsByUid[p.uid] = p; });
    const roots = [{ board: { x: 0, y: 0, w: W, h: H }, uids: Object.keys(partsByUid) }];
    const plan = this._analyzeRoots(roots, partsByUid, kerf, overrides);
    plan.W = W; plan.H = H; plan.kerf = kerf;
    plan.totalParts = (placements || []).length;
    return plan;
  },

  /* 多根分析：roots = [{board, uids}]（现场实测重建时每个未切子板各为一根）。
     与单板分析共用同一套 build/linearize，单根时输出与原 analyzeSheet 完全一致。 */
  _analyzeRoots(roots, partsByUid, kerf, overrides) {
    const self = this;
    const EPS = this.EPS;
    overrides = overrides || {};
    const plan = {
      steps: [], remnants: [], blocked: [], manual: [],
      producerOf: {}, partStep: {}, kerfLoss: 0, root: null, roots: [],
    };
    let nodeSeq = 0;
    let stepSeq = 0;

    function build(board, uids) {
      const node = {
        id: 'n' + (nodeSeq++), board, uids: uids.slice(),
        candidates: [], chosen: -1, cut: null, children: [],
        leafKind: null, uid: null, blocked: false, reason: '',
      };
      if (!uids.length) { node.leafKind = 'remnant'; return node; }
      const parts = uids.map(u => partsByUid[u]);
      node.candidates = self.candidates(board, parts, kerf);
      if (!node.candidates.length) {
        if (uids.length === 1) {
          node.leafKind = 'part';
          node.uid = uids[0];
        } else {
          node.blocked = true;
          node.reason = `${uids.length} 个零件相互交错，任何横/竖贯通直线都会切到零件`;
        }
        return node;
      }
      const key = self.boardKey(board);
      let idx = 0;
      if (overrides[key] != null) {
        idx = Math.min(Math.max(0, overrides[key] | 0), node.candidates.length - 1);
      }
      node.chosen = idx;
      node.cut = node.candidates[idx];
      const res = self.applyCut(board, node.cut, kerf);
      const ba = res[0], bb = res[1];
      plan.kerfLoss += res[2];
      const c = node.cut;
      const ua = [], ub = [];
      for (const u of uids) {
        const p = partsByUid[u];
        const lo = c.dir === 'v' ? p.x : p.y;
        const hi = c.dir === 'v' ? p.x + p.w : p.y + p.h;
        const goA = hi <= c.at + EPS;
        if ((goA && ba) || !bb) ua.push(u); else ub.push(u);
      }
      if (ba) node.children.push(build(ba, ua));
      if (bb) node.children.push(build(bb, ub));
      return node;
    }

    // 线性化：DFS 先序（父切先于子切），形成默认步骤序列
    function linearize(node) {
      if (!node.cut) {
        if (node.leafKind === 'remnant') {
          plan.remnants.push({
            x: node.board.x, y: node.board.y, w: node.board.w, h: node.board.h,
            reusable: Math.min(node.board.w, node.board.h) >= self.REUSE_MIN - EPS,
          });
        } else if (node.blocked) {
          plan.blocked.push({ board: node.board, uids: node.uids.slice(), reason: node.reason });
        }
        return;
      }
      const step = {
        id: 'c' + (stepSeq++),
        nodeId: node.id,
        nodeKey: self.boardKey(node.board),
        dir: node.cut.dir,
        at: node.cut.at,
        trim: !!node.cut.trim,
        wasteSide: node.cut.wasteSide || null,
        board: node.board,          // 切前子板
        boardId: node.id,
        candCount: node.candidates.length,
        candIndex: node.chosen,
        cands: node.candidates.map(cd => ({
          dir: cd.dir, at: cd.at, trim: !!cd.trim, wasteSide: cd.wasteSide || null,
        })),
        produces: [],
      };
      node.children.forEach(child => {
        plan.producerOf[child.id] = step.id;
        let kind = 'stock', uid = null;
        if (child.leafKind === 'part') { kind = 'part'; uid = child.uid; plan.partStep[uid] = step.id; }
        else if (child.leafKind === 'remnant') kind = 'remnant';
        else if (child.blocked) kind = 'blocked';
        step.produces.push({
          boardId: child.id, board: child.board, kind, uid, parts: child.uids.length,
        });
      });
      plan.steps.push(step);
      node.children.forEach(linearize);
    }

    roots.forEach((r) => {
      if (!r.uids.length) {
        if (r.board.w > EPS && r.board.h > EPS) {
          plan.remnants.push({
            x: r.board.x, y: r.board.y, w: r.board.w, h: r.board.h,
            reusable: Math.min(r.board.w, r.board.h) >= self.REUSE_MIN - EPS,
          });
        }
        return;
      }
      const root = build(r.board, r.uids);
      plan.roots.push(root);
      if (!plan.root) plan.root = root;
      linearize(root);
    });

    plan.manual = plan.blocked.map(b => ({
      text: `区域 ${fmtNum(b.board.w)}×${fmtNum(b.board.h)}` +
            `（位置 ${fmtNum(b.board.x)}, ${fmtNum(b.board.y)}）内 ${b.uids.length} 个零件需人工裁切`,
      reason: b.reason,
      uids: b.uids.slice(),
    }));
    return plan;
  },

  /* ---- 与当前 App 状态联动的工序状态管理 ---- */

  analyzeSheetResolved(si, overrides) {
    const def = App.sheetDef(si.sheetId) || si;
    return this.analyzeSheet(+def.width, +def.height, si.placements || [],
      +App.settings.kerf || 0, overrides);
  },

  /* 排样签名：只含影响工序的几何量（板尺寸、零件位置尺寸）与锯缝。
     拖动/旋转/增删零件、改锯缝 → 签名变化 → 旧工序失效。 */
  sigForLayout(lay) {
    const r = v => this._r3(v);
    const sheets = lay.sheets.map((si) => {
      const def = App.sheetDef(si.sheetId) || si;
      return [r(+def.width), r(+def.height),
        si.placements.map(p => [p.uid, r(p.x), r(p.y), r(p.w), r(p.h)])];
    });
    return JSON.stringify({ k: +App.settings.kerf || 0, sheets });
  },

  /* 保证 App.cutplanData 与当前方案一致；几何变化 → 旧工序失效并重新分析 */
  ensure() {
    const lay = (typeof App !== 'undefined') ? App.layout() : null;
    if (!lay) { App.cutplanData = null; return null; }
    const sig = this.sigForLayout(lay);
    if (!App.cutplan || App.cutplan.sig !== sig) {
      App._cutStates = App._cutStates || {};
      if (App.cutplan && App.cutplan.sig) {
        App._cutStates[App.cutplan.sig] = App.cutplan;
        const keys = Object.keys(App._cutStates);
        if (keys.length > this.MAX_CACHED_STATES) delete App._cutStates[keys[0]];
      }
      const cached = App._cutStates[sig] || null;
      App.cutplan = cached || {
        sig, activeSheet: 0, overrides: {}, orders: {}, cursors: {}, note: '',
      };
      if (!cached) {
        const first = lay.sheets.findIndex(s => s.placements.length);
        App.cutplan.activeSheet = first >= 0 ? first : 0;
        App.cutplan.note = '已根据当前排样重新分析裁切工序';
      }
      App.cutplanData = null;
    }
    if (!App.cutplanData) {
      const plans = lay.sheets.map((si, idx) => {
        // 已有现场确认记录 → 按实测尺寸重建（冻结已确认刀序，重算未执行步骤）
        if (typeof FieldRec !== 'undefined' && FieldRec.hasRecords(idx)) {
          return FieldRec.rebuild(idx);
        }
        return this.analyzeSheetResolved(si, App.cutplan.overrides[String(idx)] || {});
      });
      App.cutplanData = { sig, plans };
    }
    return App.cutplanData;
  },

  /* 当前步骤序列（默认 DFS 序；校验用户自定义顺序仍有效） */
  orderFor(sheetIdx) {
    const st = App.cutplan;
    const plan = App.cutplanData.plans[sheetIdx];
    const key = String(sheetIdx);
    const ids = plan.steps.map(s => s.id);
    let order = st.orders[key];
    if (!order || order.length !== ids.length ||
        !order.every(id => ids.indexOf(id) >= 0)) {
      order = ids.slice();
      st.orders[key] = order;
    }
    return order;
  },

  statsFor(sheetIdx) {
    const data = App.cutplanData;
    if (!data || !data.plans[sheetIdx]) return null;
    const plan = data.plans[sheetIdx];
    const order = this.orderFor(sheetIdx);
    const byId = {};
    plan.steps.forEach(s => { byId[s.id] = s; });
    let flips = 0, prev = null;
    for (const id of order) {
      const s = byId[id];
      if (!s) continue;
      if (prev && s.dir !== prev) flips++;
      prev = s.dir;
    }
    const sum = a => a.reduce((t, r) => t + r.w * r.h, 0);
    const reusable = plan.remnants.filter(r => r.reusable);
    return {
      cuts: plan.steps.length,
      flips,                                   // 翻板次数 = 相邻两刀方向变化次数
      remnants: plan.remnants.length,
      reusableCount: reusable.length,
      reusableArea: sum(reusable),
      wasteArea: sum(plan.remnants),
      kerfLoss: plan.kerfLoss,
      blockedCount: plan.blocked.length,
      manualCount: plan.manual.length,
      manualParts: plan.blocked.reduce((t, b) => t + b.uids.length, 0),
      partsOut: Object.keys(plan.partStep).length,
      totalParts: plan.totalParts,
      confirmed: plan.confirmedCount || 0,                 // 已确认（现场锁定）刀数
      shortfall: (plan.shortfall || []).length,            // 补料零件数
      shortfallParts: plan.shortfall || [],
    };
  },

  /* 相邻两步能否交换：后一步的子板不是由前一步产生（无依赖）即可；
     已现场确认的刀序（前 confirmedCount 步）锁定，不得换序 */
  canSwap(sheetIdx, i) {
    const plan = App.cutplanData.plans[sheetIdx];
    const order = this.orderFor(sheetIdx);
    if (i < 0 || i >= order.length - 1) return false;
    if (i < (plan.confirmedCount || 0)) return false;      // 触及已确认刀序
    const byId = {};
    plan.steps.forEach(s => { byId[s.id] = s; });
    const a = byId[order[i]], b = byId[order[i + 1]];
    if (!a || !b) return false;
    return plan.producerOf[b.boardId] !== a.id;
  },

  swap(sheetIdx, i) {
    if (!this.canSwap(sheetIdx, i)) return false;
    const order = this.orderFor(sheetIdx);
    const t = order[i];
    order[i] = order[i + 1];
    order[i + 1] = t;
    return true;
  },

  /* 切换某子板的候选切法 → 重分析该板，自定义顺序与进度重置。
     已现场确认的切法锁定，不得改写；有现场记录时走实测重建。 */
  setCandidate(sheetIdx, nodeKey, candIdx) {
    if (!App.cutplanData) return;
    const st = App.cutplan;
    const key = String(sheetIdx);
    const plan = App.cutplanData.plans[sheetIdx];
    if (plan && plan.steps &&
        plan.steps.some(s => s.confirmed && s.nodeKey === nodeKey)) return;  // 已确认刀序锁定
    st.overrides[key] = st.overrides[key] || {};
    st.overrides[key][nodeKey] = candIdx;
    if (typeof FieldRec !== 'undefined' && FieldRec.hasRecords(sheetIdx)) {
      FieldRec.rebuildInto(sheetIdx);
      delete st.orders[key];
      st.cursors[key] = FieldRec.confirmedCount(sheetIdx);
      return;
    }
    const lay = App.layout();
    App.cutplanData.plans[sheetIdx] =
      this.analyzeSheetResolved(lay.sheets[sheetIdx], st.overrides[key]);
    delete st.orders[key];
    st.cursors[key] = 0;
  },
};
