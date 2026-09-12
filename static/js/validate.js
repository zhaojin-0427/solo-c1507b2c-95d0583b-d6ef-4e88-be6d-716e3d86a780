/* 实时违规校验：重叠 / 越界 / 间距 / 纹理方向（含原料板纹理）/ 定义一致性 */
const Validate = {
  EPS: 1e-6,

  gap() { return (+App.settings.kerf || 0) + (+App.settings.spacing || 0); },
  margin() { return +App.settings.margin || 0; },

  /* 零件纹理与板材纹理是否冲突（双方均指定且不一致） */
  grainConflict(partGrain, sheetGrain) {
    return partGrain && partGrain !== 'none' &&
           sheetGrain && sheetGrain !== 'none' && partGrain !== sheetGrain;
  },
  grainLabel(g) { return { horizontal: '横向', vertical: '纵向' }[g] || '无'; },

  /* 全量校验当前方案，返回 {
       vmap: Map<uid, Set<code>>, dmap: Map<'key:did', [uid...]>, messages: [...] } */
  check() {
    const vmap = new Map();
    const dmap = new Map();
    const messages = [];
    const lay = App.layout();
    if (!lay) return { vmap, dmap, messages, grainSeams: [], grainGroups: [] };
    const gap = this.gap();
    const margin = this.margin();
    const seenMsg = new Set();

    const flag = (uid, code) => {
      if (!vmap.has(uid)) vmap.set(uid, new Set());
      vmap.get(uid).add(code);
    };
    const flagDefect = (key, did, uid) => {
      const k = key + ':' + did;
      if (!dmap.has(k)) dmap.set(k, []);
      if (dmap.get(k).indexOf(uid) < 0) dmap.get(k).push(uid);
    };
    const say = (uid, code, msg, loc) => {
      if (seenMsg.has(msg)) return;
      seenMsg.add(msg);
      messages.push({ uid, code, msg, loc: loc || null });
    };

    lay.sheets.forEach((si, sheetIdx) => {
      const def = App.sheetDef(si.sheetId) || si;
      const W = +def.width, H = +def.height;
      const ps = si.placements;
      const dkey = App.defectKey(si.sheetId, si.instance);
      const defects = App.defectsOn(si.sheetId, si.instance);

      // 缺陷越界（超出板面）
      defects.forEach((d) => {
        const bb = Defects.bbox(d);
        if (bb && (bb.x < -this.EPS || bb.y < -this.EPS || bb.x1 > W + this.EPS || bb.y1 > H + this.EPS)) {
          say(null, 'defout', `${d.id}（${Defects.TYPES[d.type] || ''}）超出板材 ${si.sheetId} #${si.instance + 1} 板面`,
              { type: 'defect', key: dkey, id: d.id, sheetIndex: sheetIdx });
        }
      });

      ps.forEach((p) => {
        const pd = App.uidPart(p.uid);
        // 越界（含板边留量）
        if (p.x < margin - this.EPS || p.y < margin - this.EPS ||
            p.x + p.w > W - margin + this.EPS || p.y + p.h > H - margin + this.EPS) {
          flag(p.uid, 'bounds');
          say(p.uid, 'bounds', `${p.uid} 超出板材可用区域（四边需留 ${fmtNum(margin)}mm）`,
              { type: 'part', uid: p.uid, sheetIndex: sheetIdx });
        }
        if (!pd) {
          flag(p.uid, 'nodef');
          say(p.uid, 'nodef', `${p.uid} 的零件定义已被删除`);
        } else {
          // 纹理 / 旋转方向（与后端 orientations 规则一致）
          if (p.rotated && !pd.rotatable) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）设为不可旋转，但当前被旋转`);
          }
          if (pd.grain === 'horizontal' && p.rotated) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）纹理须水平，禁止旋转`);
          }
          if (pd.grain === 'vertical' && !p.rotated) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）纹理须垂直，应旋转 90°`);
          }
          // 原料板纹理参与判断
          const sg = def.grain || 'none';
          if (this.grainConflict(pd.grain, sg)) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）纹理（${this.grainLabel(pd.grain)}）与板材纹理（${this.grainLabel(sg)}）冲突`);
          }
          // 尺寸与定义一致性：排样使用毛坯外廓（旋转后按毛坯宽高换向）
          const bd = App.blankDef(pd, p.rotated);
          if (Math.abs(bd.w - p.w) > 0.01 || Math.abs(bd.h - p.h) > 0.01) {
            flag(p.uid, 'size');
            const d0 = App.blankDef(pd, false);
            say(p.uid, 'size', `${p.uid} 毛坯尺寸与零件定义（成品 ${pd.width}×${pd.height}，` +
              `毛坯 ${fmtNum(d0.w)}×${fmtNum(d0.h)}）不符，请重新生成排样`);
          }
          // 板面缺陷冲突（安全外扩/面别/等级/容许区）
          const hit = Defects.blockingDefect(p, pd, defects);
          if (hit) {
            flag(p.uid, 'defect');
            flagDefect(dkey, hit.id, p.uid);
            say(p.uid, 'defect',
              `${p.uid}（${pd.name}）侵入缺陷 ${Defects.label(hit)} 的避让范围（板材 ${si.sheetId} #${si.instance + 1}）`,
              { type: 'partdefect', uid: p.uid, key: dkey, id: hit.id, sheetIndex: sheetIdx });
          }
        }
      });

      // 两两检查：重叠 / 间距不足
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
          const strict = a.x < b.x + b.w - this.EPS && b.x < a.x + a.w - this.EPS &&
                         a.y < b.y + b.h - this.EPS && b.y < a.y + a.h - this.EPS;
          if (strict) {
            flag(a.uid, 'overlap'); flag(b.uid, 'overlap');
            say(a.uid, 'overlap', `${a.uid} 与 ${b.uid} 重叠`);
          } else {
            const near = a.x < b.x + b.w + gap - this.EPS && b.x < a.x + a.w + gap - this.EPS &&
                         a.y < b.y + b.h + gap - this.EPS && b.y < a.y + a.h + gap - this.EPS;
            if (near) {
              flag(a.uid, 'spacing'); flag(b.uid, 'spacing');
              say(a.uid, 'spacing', `${a.uid} 与 ${b.uid} 间距不足（需 ≥ ${fmtNum(gap)}mm）`);
            }
          }
        }
      }
    });
    // 封边工序核对（定义级，与摆放无关）：毛坯非正 / 外露未封 / 拼接误封
    if (typeof Edging !== 'undefined') {
      App.parts.forEach((pd) => {
        const issues = Edging.partIssues(pd);
        if (!issues.length) return;
        // 该定义的已放置实例标 v-edge（毛坯问题排第一优先）
        lay.sheets.forEach(si => si.placements.forEach((pl) => {
          if (pl.partId === pd.id) flag(pl.uid, 'edge');
        }));
        issues.forEach((iss) => {
          say('part:' + pd.id, 'edge', iss.msg,
            { type: 'edge', partId: pd.id, edge: iss.edge, code: iss.code });
        });
      });
    }
    // 拼纹对花：逐缝错花量、同板要求、组完整性（与后端同口径）
    const grain = (typeof Grain !== 'undefined') ? Grain.evaluate(lay)
      : { groups: [], seams: [], badUids: new Set(), completeCount: 0, totalGroups: 0 };
    grain.groups.forEach((g) => {
      // 组内成员缺失/未放置
      g.members.forEach((m) => {
        if (!m.onBoard) {
          flag(m.uid, 'grainmatch');
          say(m.uid, 'grainmatch',
            `拼纹组 ${g.id} 成员 ${m.uid} 未放置（组不完整，无法对花）`, null);
        }
      });
      if (g.sameSheetViolation) {
        g.members.forEach((m) => flag(m.uid, 'grainmatch'));
        say(null, 'grainmatch',
          `拼纹组 ${g.id} 要求全部取自同一张板，但当前分布在多张板上`, null);
      }
    });
    // 补偿后接缝超限：逐对相邻成员按封边补偿估算最小可达成品间隙
    if (typeof Edging !== 'undefined') {
      grain.groups.forEach((g) => {
        for (let k = 0; k + 1 < g.members.length; k++) {
          const a = g.members[k], b = g.members[k + 1];
          if (!a.onBoard || !b.onBoard || a.sheetIndex !== b.sheetIndex) continue;
          const pa = App.uidPart(a.uid), pb = App.uidPart(b.uid);
          if (!pa || !pb) continue;
          const axis = g.dir === 'h' ? 'x' : 'y';
          const ra = Grain.findOnBoard(lay, a.uid).placement;
          const visTrail = axis === 'x' ? 'right' : 'bottom';
          const visLead = axis === 'x' ? 'left' : 'top';
          // 外形边 → canonical 边
          const canon = (pd, vis, rot) => Edging.canonicalKey(vis, rot);
          const ea = Edging.edge(pa, canon(pa, visTrail, !!ra.rotated));
          const rb = Grain.findOnBoard(lay, b.uid).placement;
          const eb = Edging.edge(pb, canon(pb, visLead, !!rb.rotated));
          const ta = Edging.edgeComp(ea), tb = Edging.edgeComp(eb);
          const minProd = gap - ta - tb;
          if (minProd > g.productGap + g.tolerance + this.EPS) {
            flag(a.uid, 'grainmatch'); flag(b.uid, 'grainmatch');
            const sA = `${Edging.LABELS[canon(pa, visTrail, !!ra.rotated)]}${ea.kind === 'exposed' ? '封' + fmtNum(ea.thickness) + 'mm' : ''}`;
            const sB = `${Edging.LABELS[canon(pb, visLead, !!rb.rotated)]}${eb.kind === 'exposed' ? '封' + fmtNum(eb.thickness) + 'mm' : ''}`;
            say(null, 'grainmatch',
              `拼纹组 ${g.id} 接缝 ${a.uid}–${b.uid} 补偿后超限：${a.uid} ${sA} 与 ${b.uid} ${sB} ` +
              `封边后最小成品间隙 ${fmtNum(minProd)}mm，超过成品间隙 ${fmtNum(g.productGap)}mm + 容差 ${fmtNum(g.tolerance)}mm`,
              { type: 'seam', groupId: g.id, from: a.uid, to: b.uid,
                sheetIndex: b.sheetIndex });
          }
        }
      });
    }
    grain.seams.forEach((s) => {
      if (s.qualified) return;
      flag(s.from, 'grainmatch');
      flag(s.to, 'grainmatch');
      let msg;
      if (s.status === 'unknown') {
        msg = `拼纹组 ${s.groupId} 接缝 ${s.from}–${s.to}：${s.reason || '相位无法核算'}` +
              (s.crossSheet ? '（跨板）' : '');
      } else {
        msg = `拼纹组 ${s.groupId} 接缝 ${s.from}–${s.to} 错花量 ${fmtNum(s.offset)}mm ` +
              `超过可接受值 ${fmtNum(s.tolerance)}mm` + (s.band ? '（错带）' : '') +
              (s.crossSheet ? '（跨板）' : '');
      }
      say(null, 'grainmatch', msg, { type: 'seam', groupId: s.groupId,
                                     from: s.from, to: s.to,
                                     sheetIndex: s.toSheet });
    });

    return { vmap, dmap, messages,
             grainSeams: grain.seams, grainGroups: grain.groups,
             grainSummary: { completeCount: grain.completeCount,
                             totalGroups: grain.totalGroups,
                             maxOffset: grain.maxOffset,
                             allQualified: grain.allQualified } };
  },

  /* 拖拽过程中的快速校验：候选位置是否合法（越界 / 间距 / 重叠 / 板材纹理 / 缺陷） */
  checkPlacement(sheetIdx, uid, x, y, w, h) {
    const lay = App.layout();
    if (!lay || !lay.sheets[sheetIdx]) return false;
    const si = lay.sheets[sheetIdx];
    const def = App.sheetDef(si.sheetId) || si;
    const W = +def.width, H = +def.height;
    const m = this.margin(), gap = this.gap();
    // 原料板纹理与零件纹理冲突 → 该板不可放
    const pd = App.uidPart(uid);
    if (pd && this.grainConflict(pd.grain, def.grain || 'none')) return false;
    if (x < m - this.EPS || y < m - this.EPS ||
        x + w > W - m + this.EPS || y + h > H - m + this.EPS) return false;
    for (const p of si.placements) {
      if (p.uid === uid) continue;
      if (x < p.x + p.w + gap - this.EPS && p.x < x + w + gap - this.EPS &&
          y < p.y + p.h + gap - this.EPS && p.y < y + h + gap - this.EPS) return false;
    }
    // 缺陷避让
    if (pd && Defects.blockingDefect({ x, y, w, h, rotated: Math.abs(w - pd.width) > 0.01 },
                                     pd, App.defectsOn(si.sheetId, si.instance))) return false;
    return true;
  },
};
