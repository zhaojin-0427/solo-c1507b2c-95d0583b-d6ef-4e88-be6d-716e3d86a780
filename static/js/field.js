/* 现场偏差补救：实测登记、倒序撤销、按实测重建剩余子板、补料与补救方案。
 *
 * 模型约定（与 cutplan.js 一致）：
 * - 坐标为板材绝对坐标，原点左上角，单位 mm；锯缝带 [at, at+kerf] 计入损耗；
 * - 每完成一刀，用户登记实测切线位置 actAt 与实测锯缝 actKerf，
 *   或把产出的某个子板（按上/左=a、下/右=b 侧）或零件标记为破损；
 * - 确认后保存 计划值(planAt/planKerf)、实测值(actAt/actKerf) 与记录时间 time，
 *   该刀及其上游子板锁定：换序 / 切换切法 / 重新排样都不得改写；
 * - 现场记录只能从最后一刀倒序撤销（LIFO）；
 * - 每次确认/撤销后按实测尺寸重建剩余子板：实测切线穿过的零件报废、
 *   超出实测子板边界的零件与无法贯通的区域列为补料，其余重算后续切法；
 * - 补料零件用 未切子板 / 可复用余料 / 未用原料板（不足时追加新板）生成补救方案，
 *   按 可完成零件数 / 追加板材面积 / 新增刀数 比较，选中后仅替换未执行步骤。
 *
 * 状态挂在 App.cutplan.field[板材下标] = { records: [...], remedy: {...} }，随项目保存。
 * 本模块不操作 DOM，便于在 Node 中回归测试；界面见 cutui.js。
 */
const FieldRec = {
  EPS: 1e-6,
  REUSE_MIN: 100,   // 与 CutPlan.REUSE_MIN 一致：可复用余料最小短边 (mm)

  _r3(v) { return Math.round(v * 1000) / 1000; },

  /* ---- 状态访问 ---- */
  state(sheetIdx) {
    const st = App.cutplan;
    st.field = st.field || {};
    const k = String(sheetIdx);
    if (!st.field[k]) st.field[k] = { records: [], remedy: null };
    return st.field[k];
  },
  records(sheetIdx) { return this.state(sheetIdx).records; },
  hasRecords(sheetIdx) {
    return !!(App.cutplan && App.cutplan.field &&
              App.cutplan.field[String(sheetIdx)] &&
              App.cutplan.field[String(sheetIdx)].records.length);
  },
  confirmedCount(sheetIdx) { return this.records(sheetIdx).length; },
  remedy(sheetIdx) { return this.state(sheetIdx).remedy || null; },

  /* 全部板材的已确认刀数合计（状态栏 / 打印摘要用） */
  totalConfirmed() {
    if (!App.cutplan || !App.cutplan.field) return 0;
    return Object.values(App.cutplan.field)
      .reduce((t, f) => t + (f.records ? f.records.length : 0), 0);
  },

  /* 当前排样中已确认产出的零件（重新排样时自动锁定，不得改写） */
  producedPlacements() {
    const out = [];
    const data = App.cutplanData;
    if (!data) return out;
    data.plans.forEach((plan) => {
      const pa = plan.producedActual || {};
      Object.keys(pa).forEach((uid) => {
        const b = pa[uid];
        const pd = App.uidPart(uid);
        out.push({
          uid, partId: String(uid).split('#')[0],
          name: (pd && pd.name) || uid,
          x: this._r3(b.x), y: this._r3(b.y), w: b.w, h: b.h,
          rotated: !!(pd && (Math.abs(b.w - +pd.height) < 0.01 &&
                             Math.abs(b.h - +pd.width) < 0.01) &&
                      (Math.abs(+pd.width - +pd.height) > 0.01)),
          locked: true,
        });
      });
    });
    return out;
  },

  /* 下一个待确认的刀（当前顺序中第 confirmedCount 步） */
  nextStep(sheetIdx) {
    const data = App.cutplanData;
    if (!data || !data.plans[sheetIdx]) return null;
    const plan = data.plans[sheetIdx];
    const order = CutPlan.orderFor(sheetIdx);
    const n = this.confirmedCount(sheetIdx);
    if (n >= order.length) return null;
    const byId = {};
    plan.steps.forEach(s => { byId[s.id] = s; });
    return byId[order[n]] || null;
  },

  /* 确认登记一刀。actual = { actAt, actKerf, damaged:[uid], damagedSides:['a'|'b'] }。
     计划值取自当前待确认刀，实测值缺省按计划值。确认后强制重建。 */
  confirm(sheetIdx, actual) {
    const step = this.nextStep(sheetIdx);
    if (!step) return null;
    const plan = App.cutplanData.plans[sheetIdx];
    actual = actual || {};
    let actKerf = (actual.actKerf != null && isFinite(+actual.actKerf)) ? +actual.actKerf : plan.kerf;
    actKerf = Math.max(0, actKerf);
    // 实测切线钳制在"锯缝带仍与子板相交"的范围内（修边刀的锯缝带可部分在板外）
    let actAt = (actual.actAt != null && isFinite(+actual.actAt)) ? +actual.actAt : step.at;
    const blo = step.dir === 'v' ? step.board.x : step.board.y;
    const bhi = step.dir === 'v' ? step.board.x + step.board.w : step.board.y + step.board.h;
    actAt = Math.max(blo - actKerf, Math.min(bhi, actAt));
    const rec = {
      nodeKey: step.nodeKey,
      planDir: step.dir,
      planAt: step.at,
      planKerf: plan.kerf,
      actAt: this._r3(actAt),
      actKerf: this._r3(actKerf),
      damaged: (actual.damaged || []).slice(),
      damagedSides: (actual.damagedSides || []).slice(),
      time: Date.now(),
    };
    this.records(sheetIdx).push(rec);
    App.cutplanData = null;                 // 强制按实测重建
    CutPlan.ensure();
    App.cutplan.cursors[String(sheetIdx)] = this.confirmedCount(sheetIdx);
    return rec;
  },

  /* 撤销最后一条现场记录（仅 LIFO）；同时使已选补救方案失效 */
  undoLast(sheetIdx) {
    const recs = this.records(sheetIdx);
    if (!recs.length) return false;
    recs.pop();
    this.state(sheetIdx).remedy = null;
    App.cutplanData = null;
    CutPlan.ensure();
    App.cutplan.cursors[String(sheetIdx)] = this.confirmedCount(sheetIdx);
    return true;
  },

  /* 把重建结果写回 App.cutplanData.plans[sheetIdx]（setCandidate 等局部刷新用） */
  rebuildInto(sheetIdx) {
    if (!App.cutplanData) { CutPlan.ensure(); return; }
    App.cutplanData.plans[sheetIdx] = this.rebuild(sheetIdx);
  },

  /* ---- 核心：按实测尺寸重建该板工序 ----
     返回 plan = 已确认步骤（冻结，含计划/实测值）+ 未执行步骤（按实测子板重算），
     并给出 shortfall（补料）、issues、liveBoards、producedActual 等。 */
  rebuild(sheetIdx) {
    const lay = App.layout();
    const si = lay.sheets[sheetIdx];
    const def = App.sheetDef(si.sheetId) || si;
    const W = +def.width, H = +def.height;
    const kerf = +App.settings.kerf || 0;
    const placements = si.placements || [];
    const partsByUid = {};
    placements.forEach(p => { partsByUid[p.uid] = p; });
    const records = this.records(sheetIdx);
    const overrides = App.cutplan.overrides[String(sheetIdx)] || {};
    const EPS = this.EPS;

    const plan = {
      W, H, kerf, totalParts: placements.length,
      steps: [], remnants: [], blocked: [], manual: [],
      producerOf: {}, partStep: {}, kerfLoss: 0,
      shortfall: [], issues: [], liveBoards: [], liveNodes: [],
      damagedParts: [], damagedBoards: [], producedActual: {},
      confirmedCount: records.length, root: null, roots: [],
    };

    const shortSet = new Set();
    const toShort = (uid, reason) => {
      if (shortSet.has(uid)) return;
      shortSet.add(uid);
      const p = partsByUid[uid];
      plan.shortfall.push({
        uid, name: p ? (p.name || uid) : uid,
        w: p ? p.w : 0, h: p ? p.h : 0, reason,
      });
    };

    // 未切子板 frontier：初始为整板（实测尺寸 = 计划板尺寸）
    let live = [{ board: { x: 0, y: 0, w: W, h: H }, uids: Object.keys(partsByUid) }];

    const classify = (board, uids) => {
      if (!uids.length) return { kind: 'remnant', board, uids };
      const parts = uids.map(u => partsByUid[u]);
      const cands = CutPlan.candidates(board, parts, kerf);
      if (!cands.length && uids.length === 1) return { kind: 'part', board, uids };
      if (!cands.length) return { kind: 'blocked', board, uids };
      return { kind: 'stock', board, uids };
    };

    // 逐刀应用已确认记录（实测值）
    records.forEach((rec, ri) => {
      let li = live.findIndex(b => CutPlan.boardKey(b.board) === rec.nodeKey);
      if (li < 0) li = 0;   // 兜底：签名漂移时仍保持确定行为
      const target = live.splice(li, 1)[0];
      const res = CutPlan.applyCut(target.board, { dir: rec.planDir, at: rec.actAt }, rec.actKerf);
      const ba = res[0], bb = res[1];
      plan.kerfLoss += res[2];
      // 按计划零件位置与实测锯缝带分配零件归属；被锯缝带穿过 → 报废补料
      const bandLo = rec.actAt, bandHi = rec.actAt + rec.actKerf;
      const ua = [], ub = [];
      target.uids.forEach((u) => {
        const p = partsByUid[u];
        const lo = rec.planDir === 'v' ? p.x : p.y;
        const hi = rec.planDir === 'v' ? p.x + p.w : p.y + p.h;
        if (hi <= bandLo + EPS) ua.push(u);
        else if (lo >= bandHi - EPS) ub.push(u);
        else toShort(u, '实测切线穿过零件，零件报废');
      });
      const dam = new Set(rec.damaged || []);
      dam.forEach(u => toShort(u, '现场标记破损'));
      const damSides = new Set(rec.damagedSides || []);

      const step = {
        id: 'f' + ri, confirmed: true,
        dir: rec.planDir, at: rec.actAt,
        planAt: rec.planAt, planKerf: rec.planKerf,
        actAt: rec.actAt, actKerf: rec.actKerf,
        time: rec.time, damaged: (rec.damaged || []).slice(),
        board: target.board, boardId: 'fb' + ri, nodeKey: rec.nodeKey,
        trim: false, wasteSide: null,
        candCount: 0, candIndex: -1, cands: [],
        produces: [],
      };
      const children = [
        ba ? { side: 'a', board: ba, uids: ua.filter(u => !dam.has(u)) } : null,
        bb ? { side: 'b', board: bb, uids: ub.filter(u => !dam.has(u)) } : null,
      ];
      children.forEach((ch) => {
        if (!ch) return;
        const ckey = CutPlan.boardKey(ch.board);
        if (damSides.has(ch.side)) {
          plan.damagedBoards.push(ch.board);
          ch.uids.forEach(u => toShort(u, '所在子板现场标记破损'));
          step.produces.push({ boardId: ckey, board: ch.board, kind: 'damaged', uid: null, parts: ch.uids.length });
          return;
        }
        const cls = classify(ch.board, ch.uids);
        if (cls.kind === 'remnant') {
          plan.remnants.push({
            x: ch.board.x, y: ch.board.y, w: ch.board.w, h: ch.board.h,
            reusable: Math.min(ch.board.w, ch.board.h) >= this.REUSE_MIN - EPS,
          });
          step.produces.push({ boardId: ckey, board: ch.board, kind: 'remnant', uid: null, parts: 0 });
        } else if (cls.kind === 'part') {
          const u = ch.uids[0];
          plan.partStep[u] = step.id;
          plan.producedActual[u] = ch.board;
          step.produces.push({ boardId: ckey, board: ch.board, kind: 'part', uid: u, parts: 1 });
        } else if (cls.kind === 'blocked') {
          plan.blocked.push({ board: ch.board, uids: ch.uids.slice(), reason: '实测后无法贯通裁切' });
          step.produces.push({ boardId: ckey, board: ch.board, kind: 'blocked', uid: null, parts: ch.uids.length });
        } else {
          live.push({ board: ch.board, uids: ch.uids });
          step.produces.push({ boardId: ckey, board: ch.board, kind: 'stock', uid: null, parts: ch.uids.length });
        }
      });
      plan.steps.push(step);
    });

    // 待执行：实测子板内仍可容纳的零件 → 重算切法；越界零件 → 补料
    const roots = [];
    live.forEach((node) => {
      const b = node.board;
      const keep = [];
      node.uids.forEach((u) => {
        const p = partsByUid[u];
        const inside = p.x >= b.x - EPS && p.y >= b.y - EPS &&
                       p.x + p.w <= b.x + b.w + EPS && p.y + p.h <= b.y + b.h + EPS;
        if (inside) keep.push(u);
        else toShort(u, '超出实测子板边界，无法完成');
      });
      if (keep.length) roots.push({ board: b, uids: keep });
      else if (b.w > EPS && b.h > EPS) {
        plan.remnants.push({
          x: b.x, y: b.y, w: b.w, h: b.h,
          reusable: Math.min(b.w, b.h) >= this.REUSE_MIN - EPS,
        });
      }
    });
    plan.liveNodes = roots.map(r => ({ board: r.board, uids: r.uids.slice() }));
    plan.liveBoards = roots.map(r => r.board);

    let pending = { steps: [], remnants: [], blocked: [], producerOf: {}, partStep: {}, kerfLoss: 0 };
    if (roots.length) pending = CutPlan._analyzeRoots(roots, partsByUid, kerf, overrides);
    pending.steps.forEach((s) => { s.confirmed = false; plan.steps.push(s); });
    plan.remnants = plan.remnants.concat(pending.remnants);
    plan.blocked = plan.blocked.concat(pending.blocked || []);
    plan.kerfLoss += pending.kerfLoss;
    Object.assign(plan.partStep, pending.partStep);
    Object.assign(plan.producerOf, pending.producerOf);
    plan.roots = pending.roots || [];
    plan.root = plan.roots[0] || null;

    plan.manual = plan.blocked.map(b => ({
      text: `区域 ${fmtNum(b.board.w)}×${fmtNum(b.board.h)}` +
            `（位置 ${fmtNum(b.board.x)}, ${fmtNum(b.board.y)}）内 ${b.uids.length} 个零件需人工裁切`,
      reason: b.reason, uids: b.uids.slice(),
    }));
    plan.shortfall.forEach(sf => plan.issues.push(`${sf.uid}（${sf.name}）${sf.reason} → 补料`));
    plan.blocked.forEach(b =>
      plan.issues.push(`子板 ${fmtNum(b.board.w)}×${fmtNum(b.board.h)} 内 ${b.uids.length} 件无法贯通裁切`));
    return plan;
  },

  /* ---- 补救方案 ---- */

  /* 零件在指定纹理板材上的允许方向（与 nesting.orientations 一致） */
  _orients(p, boardGrain) {
    const g = p.grain || 'none';
    const rot = p.rotatable !== false;
    const bg = boardGrain || 'none';
    if (g !== 'none' && bg !== 'none' && g !== bg) return [];
    if (g === 'horizontal') return [[p.w, p.h, false]];
    if (g === 'vertical') return rot ? [[p.h, p.w, true]] : [];
    if (rot && Math.abs(p.w - p.h) > this.EPS) return [[p.w, p.h, false], [p.h, p.w, true]];
    return [[p.w, p.h, false]];
  },

  /* 简单 Bottom-Left 首适装箱：把 parts 装进 boards（不新增板）。
     返回 { placed: [{uid,boardKey,x,y,w,h,rotated}], unplaced: [uid] }。 */
  _packBL(parts, boards, gap) {
    const EPS = this.EPS;
    const placed = [];
    const unplaced = [];
    const state = boards.map(b => ({ def: b, rects: [] }));
    parts.forEach((p) => {
      let done = false;
      for (const st of state) {
        const b = st.def;
        const orients = this._orients(p, b.grain);
        if (!orients.length) continue;
        let best = null;
        const cands = [[0, 0]];
        st.rects.forEach(r => { cands.push([r.x + r.w + gap, r.y]); cands.push([r.x, r.y + r.h + gap]); });
        for (const [w, h, rot] of orients) {
          if (w > b.w + EPS || h > b.h + EPS) continue;
          for (const [cx, cy] of cands) {
            if (cx + w > b.w + EPS || cy + h > b.h + EPS) continue;
            let conf = false;
            for (const r of st.rects) {
              if (cx < r.x + r.w + gap - EPS && r.x < cx + w + gap - EPS &&
                  cy < r.y + r.h + gap - EPS && r.y < cy + h + gap - EPS) { conf = true; break; }
            }
            if (conf) continue;
            if (!best || cy < best[1] || (cy === best[1] && cx < best[0])) best = [cx, cy, w, h, rot];
          }
        }
        if (best) {
          st.rects.push({ x: best[0], y: best[1], w: best[2], h: best[3] });
          placed.push({ uid: p.uid, boardKey: b.key, x: best[0], y: best[1], w: best[2], h: best[3], rotated: best[4] });
          done = true;
          break;
        }
      }
      if (!done) unplaced.push(p.uid);
    });
    return { placed, unplaced };
  },

  /* 收集可用材料：可复用余料（含实测子板腾空）+ 未用原料板；新板模板用于追加 */
  _materials(sheetIdx) {
    const plan = App.cutplanData.plans[sheetIdx];
    const lay = App.layout();
    const si = lay.sheets[sheetIdx];
    const def = App.sheetDef(si.sheetId) || si;
    const grain = def.grain || 'none';
    const remnantBoards = (plan.remnants || [])
      .filter(r => r.reusable)
      .map((r, i) => ({ key: 'rem' + i, w: r.w, h: r.h, source: '余料', grain, isNew: false }));
    const emptySheets = [];
    lay.sheets.forEach((s2, idx2) => {
      if (idx2 !== sheetIdx && !(s2.placements || []).length) {
        const d2 = App.sheetDef(s2.sheetId) || s2;
        emptySheets.push({
          key: 'empty' + idx2, w: +d2.width, h: +d2.height,
          source: '未用板', sheetId: s2.sheetId, grain: d2.grain || 'none', isNew: false,
        });
      }
    });
    // 追加新板模板：优先与当前板同定义，否则第一张原料板
    const curDef = App.sheetDef(si.sheetId);
    const tpl = curDef || App.sheets[0] || null;
    const newTemplate = tpl ? {
      w: +tpl.width, h: +tpl.height, sheetId: tpl.id, grain: tpl.grain || 'none', isNew: true,
    } : null;
    return { remnantBoards, emptySheets, newTemplate };
  },

  /* 生成补救方案：返回若干方案，含 可完成零件数 / 追加板材面积 / 新增刀数 / 每板切工 */
  remedyPlans(sheetIdx) {
    const data = App.cutplanData;
    if (!data || !data.plans[sheetIdx]) return [];
    const plan = data.plans[sheetIdx];
    if (!plan.shortfall || !plan.shortfall.length) return [];
    const kerf = plan.kerf;
    const gap = kerf + (+App.settings.spacing || 0);
    const parts = plan.shortfall.map((sf) => {
      const pd = App.uidPart(sf.uid) || {};
      return {
        uid: sf.uid, w: sf.w, h: sf.h,
        rotatable: pd.rotatable !== false, grain: pd.grain || 'none',
      };
    });
    const { remnantBoards, emptySheets, newTemplate } = this._materials(sheetIdx);
    const onHand = remnantBoards.concat(emptySheets);

    // 由装箱结果组装方案对象（计算新增刀数 / 追加面积 / 每板切工）
    function makePlan(name, desc, baseBoards, placed, unplaced, newBoardsUsed) {
      const byBoard = {};
      placed.forEach(pl => { (byBoard[pl.boardKey] = byBoard[pl.boardKey] || []).push(pl); });
      const boards = [];
      let newCuts = 0, addedArea = 0;
      baseBoards.concat(newBoardsUsed || []).forEach((b) => {
        const ps = byBoard[b.key];
        if (!ps || !ps.length) return;
        const placements = ps.map(pl => ({
          uid: pl.uid, partId: String(pl.uid).split('#')[0],
          name: (App.uidPart(pl.uid) || {}).name || pl.uid,
          x: pl.x, y: pl.y, w: pl.w, h: pl.h, rotated: pl.rotated, locked: false,
        }));
        const sub = CutPlan.analyzeSheet(b.w, b.h, placements, kerf, {});
        newCuts += sub.steps.length;
        if (b.isNew) addedArea += b.w * b.h;
        boards.push({
          key: b.key, w: b.w, h: b.h, source: b.source, sheetId: b.sheetId || null,
          isNew: !!b.isNew, placements, steps: sub.steps, remnants: sub.remnants,
          cuts: sub.steps.length,
        });
      });
      return {
        name, desc,
        completed: placed.length, total: parts.length,
        addedArea, newCuts, boards, unplaced: unplaced.slice(),
      };
    }

    const plans = [];

    // 逐块追加新板直到把 parts 装完（或单件都装不下为止），返回 {newBoards, placed, unplaced}
    const packIntoNew = (todoParts) => {
      const newBoards = [];
      const placed = [];
      const done = new Set();
      let guard = 0;
      while (todoParts.some(p => !done.has(p.uid)) && guard < 50) {
        guard++;
        const nb = Object.assign({ key: 'new' + newBoards.length, source: '新板' }, newTemplate);
        const todo = todoParts.filter(p => !done.has(p.uid));
        const rr = this._packBL(todo, [nb], gap);
        if (!rr.placed.length) break;   // 剩余单件都装不进新板
        newBoards.push(nb);
        rr.placed.forEach((pl) => { done.add(pl.uid); placed.push(pl); });
      }
      const unplaced = todoParts.filter(p => !done.has(p.uid)).map(p => p.uid);
      return { newBoards, placed, unplaced };
    };

    // 方案一：仅用现有材料（余料 + 未用板），不追加新板
    if (onHand.length) {
      const r1 = this._packBL(parts, onHand, gap);
      plans.push(makePlan('利用现有余料/未用板', '不追加板材，尽量利用手头余料与未用原料板',
        onHand, r1.placed, r1.unplaced, null));
    }

    // 方案二：全部追加新板
    if (newTemplate) {
      const r2 = packIntoNew(parts);
      plans.push(makePlan('追加新板', '全部补料件用新购原料板裁切',
        [], r2.placed, r2.unplaced, r2.newBoards));
    }

    // 方案三：现有材料优先，不足部分追加新板
    if (newTemplate && onHand.length) {
      const r3 = this._packBL(parts, onHand, gap);
      const restParts = parts.filter(p => r3.unplaced.indexOf(p.uid) >= 0);
      const r3new = packIntoNew(restParts);
      plans.push(makePlan('余料优先 + 新板补足', '先用手头余料/未用板，剩余补料件追加新板',
        onHand, r3.placed.concat(r3new.placed), r3new.unplaced, r3new.newBoards));
    }

    // 排序：可完成零件数 ↓ → 追加板材面积 ↑ → 新增刀数 ↑
    plans.sort((a, b) =>
      (b.completed - a.completed) || (a.addedArea - b.addedArea) || (a.newCuts - b.newCuts));
    plans.forEach((p, i) => { p.id = i; });
    return plans;
  },

  /* 采用某个补救方案：仅追加补料工序（不触碰已确认刀序），随项目保存 */
  applyRemedy(sheetIdx, planObj) {
    if (!planObj) return null;
    const st = this.state(sheetIdx);
    st.remedy = {
      name: planObj.name, desc: planObj.desc, time: Date.now(),
      completed: planObj.completed, total: planObj.total,
      addedArea: planObj.addedArea, newCuts: planObj.newCuts,
      unplaced: (planObj.unplaced || []).slice(),
      boards: planObj.boards.map(b => ({
        key: b.key, w: b.w, h: b.h, source: b.source, sheetId: b.sheetId || null,
        isNew: !!b.isNew, cuts: b.cuts,
        placements: b.placements.map(p => ({
          uid: p.uid, partId: p.partId, name: p.name,
          x: p.x, y: p.y, w: p.w, h: p.h, rotated: !!p.rotated,
        })),
        steps: b.steps.map(s => ({
          dir: s.dir, at: s.at, trim: !!s.trim, wasteSide: s.wasteSide || null,
          board: { x: s.board.x, y: s.board.y, w: s.board.w, h: s.board.h },
        })),
      })),
    };
    return st.remedy;
  },

  clearRemedy(sheetIdx) { this.state(sheetIdx).remedy = null; },
};
