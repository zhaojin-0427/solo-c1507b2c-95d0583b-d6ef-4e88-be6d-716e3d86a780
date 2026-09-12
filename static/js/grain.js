/* 拼纹对花：纯几何/相位评估 + 实时接缝分析 + 最近全部合格摆位。
 *
 * 与后端 nesting.py 同口径：
 * - 纹理沿 sheet.grain 方向（horizontal→x，vertical→y，none→沿拼链）；
 * - 同一张板上，纹理轴与拼链同向时，错花量 = wrap(板上净距 - 成品间隙, 周期)；
 * - 纹理轴沿拼缝（与拼链垂直）时，要求同带；同板同带错花量为 0，
 *   跨板比较两侧基点相位；错带量直接计入错花量；
 * - 未记录纹理周期（grainPeriod=0）→ status='unknown'，接缝不算合格；
 * - status: 'ok'（已核算，offset 即错花量）| 'unknown'（无法核算）。
 *
 * 派生数据挂在 App.violations.grainSeams / grainGroups，由 Validate.check 调用。
 * 本模块不操作 DOM（装配预览界面见 grainui.js），可在 Node 中回归测试。
 */
const Grain = {
  EPS: 1e-6,

  normGroup(g) {
    const members = [];
    (g.members || []).forEach(u => { if (u && !members.includes(u)) members.push(u); });
    return {
      id: g.id || 'G?',
      dir: g.dir === 'v' ? 'v' : 'h',
      productGap: Math.max(0, +g.productGap || 0),
      tolerance: Math.max(0, +g.tolerance || 0),
      sameSheet: !!g.sameSheet,
      members,
    };
  },

  groups() { return (App.grainGroups || []).map(g => this.normGroup(g)); },

  groupOf(uid) { return this.groups().find(g => g.members.includes(uid)) || null; },

  phaseWrap(v, T) {
    if (!(T > this.EPS)) return Math.abs(v);
    return Math.abs(v - T * Math.round(v / T));
  },

  /* 板材信息：兼容排样结果内联字段（grain/grainPeriod/grainBase）与定义表 */
  sheetInfo(lay, sheetIndex) {
    const si = lay.sheets[sheetIndex];
    const def = App.sheetDef(si.sheetId) || {};
    const gb = si.grainBase || def.grainBase || { x: 0, y: 0 };
    return {
      grain: si.grain || def.grain || 'none',
      period: +(si.grainPeriod != null ? si.grainPeriod : def.grainPeriod) || 0,
      base: { x: +(gb.x || 0), y: +(gb.y || 0) },
      id: si.sheetId, instance: si.instance,
    };
  },

  grainAxis(info, chain) {
    if (info.grain === 'horizontal') return 'x';
    if (info.grain === 'vertical') return 'y';
    return chain;
  },

  /* 与 nesting.evaluate_seam 同口径。prev/cur 为绝对坐标放置记录；
     sPrev/sCur 为 sheetInfo；gapSheet 可显式给定板上净距。 */
  evaluateSeam(prev, cur, axis, productGap, sPrev, sCur, gapSheet) {
    if (gapSheet == null) {
      gapSheet = axis === 'x'
        ? cur.x - (prev.x + prev.w)
        : cur.y - (prev.y + prev.h);
    }
    const Tp = +sPrev.period || 0, Tc = +sCur.period || 0;
    const sameBoard = sPrev.id === sCur.id && sPrev.instance === sCur.instance;
    const gax = this.grainAxis(sPrev, axis);
    const unk = reason => ({ offset: 0, status: 'unknown', band: false, reason });

    // 双方均无纹理方向且无周期：没有花纹可对，接缝免核
    if (sPrev.grain === 'none' && sCur.grain === 'none' && !(Tp > this.EPS) && !(Tc > this.EPS)) {
      return { offset: 0, status: 'ok', band: false, reason: '' };
    }

    if (gax === axis) {
      let front, edge, ba, bb;
      if (axis === 'x') {
        front = cur.x; edge = prev.x + prev.w; ba = sPrev.base.x; bb = sCur.base.x;
      } else {
        front = cur.y; edge = prev.y + prev.h; ba = sPrev.base.y; bb = sCur.base.y;
      }
      if (sameBoard) {
        if (!(Tp > this.EPS)) return unk('原料板未记录纹理重复周期，无法核算沿纹理方向的错花量');
        return { offset: this.phaseWrap(gapSheet - productGap, Tp), status: 'ok', band: false, reason: '' };
      }
      if (!(Tp > this.EPS) || !(Tc > this.EPS)) return unk('原料板未记录纹理重复周期，跨板接缝相位无法核算');
      if (Math.abs(Tp - Tc) > this.EPS) return unk('两张原料板纹理周期不一致，接缝相位无法对齐');
      return { offset: this.phaseWrap((front - bb) - (edge - ba) - productGap, Tp),
               status: 'ok', band: false, reason: '' };
    }

    // 纹理轴沿拼缝：同带 + 两侧带向相位
    const cross = axis === 'x' ? 'y' : 'x';
    let pa, pb, band;
    if (cross === 'y') {
      pa = prev.y - sPrev.base.y; pb = cur.y - sCur.base.y;
      band = Math.abs(cur.y - prev.y);
    } else {
      pa = prev.x - sPrev.base.x; pb = cur.x - sCur.base.x;
      band = Math.abs(cur.x - prev.x);
    }
    if (band > this.EPS) {
      return { offset: band, status: 'ok', band: true, reason: '成员未处于同一条带（错带）' };
    }
    if (sameBoard) return { offset: 0, status: 'ok', band: false, reason: '' };
    if (!(Tp > this.EPS) || !(Tc > this.EPS)) return unk('原料板未记录纹理重复周期，跨板带向相位无法核算');
    if (Math.abs(Tp - Tc) > this.EPS) return unk('两张原料板纹理周期不一致，带向相位无法对齐');
    return { offset: this.phaseWrap(pb - pa, Tp), status: 'ok', band: false, reason: '' };
  },

  seamQualified(seam, tol) {
    return seam.status !== 'unknown' && seam.offset <= tol + this.EPS;
  },

  /* 找到 uid 的放置（绝对坐标）：{sheetIndex, placement} */
  findOnBoard(lay, uid) {
    for (let si = 0; si < lay.sheets.length; si++) {
      const p = lay.sheets[si].placements.find(q => q.uid === uid);
      if (p) return { sheetIndex: si, placement: p };
    }
    return null;
  },

  /* 全量评估当前方案：返回 {groups:[...], seams:[...], maxOffset,
     completeCount, totalGroups, allQualified, badUids:Set, seamByPair:Map} */
  evaluate(lay) {
    const groups = this.groups();
    const seams = [];
    const groupOut = [];
    const badUids = new Set();
    let maxOffset = 0;

    groups.forEach((g) => {
      const axis = g.dir === 'h' ? 'x' : 'y';
      const members = [];
      let prev = null;
      let placedCnt = 0;
      let badCnt = 0, unkCnt = 0;
      let gMax = 0;
      const sameSheetSet = new Set();

      g.members.forEach((uid, mi) => {
        const hit = lay ? this.findOnBoard(lay, uid) : null;
        const member = { uid, memberIndex: mi, onBoard: !!hit, sheetIndex: hit ? hit.sheetIndex : null };
        if (hit) {
          placedCnt++;
          sameSheetSet.add(hit.sheetIndex);
          if (prev) {
            const sPrev = this.sheetInfo(lay, prev.sheetIndex);
            const sCur = this.sheetInfo(lay, hit.sheetIndex);
            const seam = this.evaluateSeam(prev.placement, hit.placement, axis,
                                           g.productGap, sPrev, sCur);
            const qualified = this.seamQualified(seam, g.tolerance);
            if (!qualified) {
              badCnt++;
              badUids.add(prev.uid); badUids.add(uid);
            }
            if (seam.status === 'unknown') unkCnt++;
            gMax = Math.max(gMax, seam.status === 'unknown' ? 0 : seam.offset);
            const row = {
              groupId: g.id, from: prev.uid, to: uid,
              fromSheet: prev.sheetIndex, toSheet: hit.sheetIndex,
              crossSheet: prev.sheetIndex !== hit.sheetIndex,
              axis, offset: seam.offset, status: seam.status,
              band: seam.band, reason: seam.reason,
              tolerance: g.tolerance, productGap: g.productGap,
              qualified,
              // 画布定位用：缝在板上的中点（同板）或各自边缘
              fromEdge: axis === 'x'
                ? { x: prev.placement.x + prev.placement.w, y: prev.placement.y, h: prev.placement.h, sheetIndex: prev.sheetIndex }
                : { x: prev.placement.x, y: prev.placement.y + prev.placement.h, w: prev.placement.w, sheetIndex: prev.sheetIndex },
              toEdge: axis === 'x'
                ? { x: hit.placement.x, y: hit.placement.y, h: hit.placement.h, sheetIndex: hit.sheetIndex }
                : { x: hit.placement.x, y: hit.placement.y, w: hit.placement.w, sheetIndex: hit.sheetIndex },
            };
            seams.push(row);
          }
          prev = { uid, sheetIndex: hit.sheetIndex, placement: hit.placement };
        } else {
          prev = null;
          badUids.add(uid);
        }
        members.push(member);
      });

      const allPlaced = placedCnt === g.members.length;
      const sameSheetOk = !g.sameSheet || sameSheetSet.size <= 1;
      if (!sameSheetOk) {
        g.members.forEach(u => badUids.add(u));
      }
      let status;
      if (allPlaced && badCnt === 0 && unkCnt === 0 && sameSheetOk) status = 'complete';
      else if (placedCnt === 0) status = 'failed';
      else status = 'partial';

      groupOut.push({
        ...g, members, status, placedCount: placedCnt,
        badSeamCount: badCnt, unknownSeamCount: unkCnt,
        sameSheetViolation: !sameSheetOk,
        maxOffset: Math.round(gMax * 100) / 100,
      });
      maxOffset = Math.max(maxOffset, gMax);
    });

    const completeCount = groupOut.filter(g => g.status === 'complete').length;
    return {
      groups: groupOut, seams,
      maxOffset: Math.round(maxOffset * 100) / 100,
      completeCount, totalGroups: groups.length,
      allQualified: groupOut.every(g => g.status === 'complete'),
      badUids,
    };
  },

  /* ---- 最近一次全部合格的摆位（按方案保存快照） ---- */
  checkpointKey(lay) { return lay && lay.id; },

  saveCheckpoint(lay) {
    if (!lay || lay.empty) return false;
    const ev = this.evaluate(lay);
    // 全部组完整且接缝合格，且无其它几何违规（重叠/越界等由调用方先行判定）
    if (!ev.allQualified) return false;
    lay._lastGood = {
      at: Date.now(),
      placements: JSON.stringify(lay.sheets.map(s => s.placements)),
    };
    return true;
  },

  hasCheckpoint(lay) {
    // 不能回退到"与当前完全相同"的快照
    return !!(lay && lay._lastGood &&
      lay._lastGood.placements !== JSON.stringify(lay.sheets.map(s => s.placements)));
  },

  restoreCheckpoint(lay) {
    if (!this.hasCheckpoint(lay)) return false;
    const ps = JSON.parse(lay._lastGood.placements);
    lay.sheets.forEach((s, i) => { s.placements = ps[i]; });
    return true;
  },
};

/* 全局快捷：移动/旋转/换板后逐缝更新（renderAll 时 Validate 会重新评估并缓存） */
function grainCurrent() {
  const lay = App.layout();
  if (!lay) return Grain.evaluate({ sheets: [] });
  return Grain.evaluate(lay);
}
