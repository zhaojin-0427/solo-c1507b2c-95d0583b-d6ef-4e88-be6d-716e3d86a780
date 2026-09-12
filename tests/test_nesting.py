"""排样引擎与后端 API 回归测试。

覆盖：
- 既有排样能力（无重叠/越界、间距满足、数量守恒）—— 回归
- 锁定重排保持 —— 回归
- 保存/恢复/删除 API —— 回归
- 缺陷3：rotatable=False 不为满足纹理而旋转；原料板纹理参与放置判断；
  无法满足时列入未放置并说明原因
- 板面缺陷避让：矩形/多边形缺陷安全外扩、等级容许、正反面相遇、容许区豁免、
  无法避让时说明冲突板材与缺陷、合格零件数与避让碎料面积统计、项目保存缺陷

运行：python3 -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nesting import generate_layouts, orientations  # noqa: E402

SETTINGS = {"kerf": 3, "margin": 5, "spacing": 2}
GAP = SETTINGS["kerf"] + SETTINGS["spacing"]
MARGIN = SETTINGS["margin"]


def sample_payload():
    return {
        "settings": dict(SETTINGS),
        "sheets": [{"id": "S1", "name": "多层板", "width": 2440, "height": 1220,
                    "grain": "horizontal", "quantity": 2}],
        "parts": [
            {"id": "P1", "name": "侧板", "width": 600, "height": 400, "quantity": 4,
             "rotatable": True, "grain": "none"},
            {"id": "P2", "name": "层板", "width": 560, "height": 300, "quantity": 6,
             "rotatable": True, "grain": "none"},
            {"id": "P3", "name": "门板", "width": 500, "height": 350, "quantity": 4,
             "rotatable": False, "grain": "horizontal"},
            {"id": "P4", "name": "背板", "width": 580, "height": 380, "quantity": 2,
             "rotatable": True, "grain": "none"},
        ],
    }


def assert_layout_valid(tc, lay, total_parts):
    """通用不变量：无越界、间距满足、数量守恒、计数一致。"""
    placed_total = 0
    for s in lay["sheets"]:
        ps = s["placements"]
        placed_total += len(ps)
        for p in ps:
            tc.assertGreaterEqual(p["x"], MARGIN - 1e-6, f"{p['uid']} 越界")
            tc.assertGreaterEqual(p["y"], MARGIN - 1e-6, f"{p['uid']} 越界")
            tc.assertLessEqual(p["x"] + p["w"], s["width"] - MARGIN + 1e-6, f"{p['uid']} 越界")
            tc.assertLessEqual(p["y"] + p["h"], s["height"] - MARGIN + 1e-6, f"{p['uid']} 越界")
        for i in range(len(ps)):
            for j in range(i + 1, len(ps)):
                a, b = ps[i], ps[j]
                bad = (a["x"] < b["x"] + b["w"] + GAP - 1e-6 and
                       b["x"] < a["x"] + a["w"] + GAP - 1e-6 and
                       a["y"] < b["y"] + b["h"] + GAP - 1e-6 and
                       b["y"] < a["y"] + a["h"] + GAP - 1e-6)
                tc.assertFalse(bad, f"{a['uid']} 与 {b['uid']} 重叠/间距不足")
    tc.assertEqual(placed_total + lay["stats"]["unplacedCount"], total_parts, "零件数量不守恒")
    tc.assertEqual(lay["stats"]["placedCount"], placed_total, "placedCount 统计不一致")


class TestNestingRegression(unittest.TestCase):
    """既有排样能力回归"""

    def test_sample_all_placed(self):
        res = generate_layouts(sample_payload())
        self.assertFalse(res.get("error"))
        self.assertTrue(res["layouts"])
        self.assertEqual(res["layouts"][0]["stats"]["unplacedCount"], 0)
        for lay in res["layouts"]:
            assert_layout_valid(self, lay, 16)

    def test_rotatable_false_never_rotated(self):
        res = generate_layouts(sample_payload())
        for lay in res["layouts"]:
            for s in lay["sheets"]:
                for p in s["placements"]:
                    if p["partId"] == "P3":  # rotatable=False
                        self.assertFalse(p["rotated"], "rotatable=False 的零件被旋转")

    def test_locked_renest_preserved(self):
        payload = sample_payload()
        payload["locked"] = {"0": [{"uid": "P1#1", "partId": "P1", "x": 5.0, "y": 5.0,
                                    "w": 600, "h": 400, "rotated": False}]}
        res = generate_layouts(payload)
        self.assertTrue(res["layouts"])
        for lay in res["layouts"]:
            locked = [p for p in lay["sheets"][0]["placements"] if p["uid"] == "P1#1"]
            self.assertTrue(locked, "锁定件丢失")
            self.assertEqual((locked[0]["x"], locked[0]["y"]), (5.0, 5.0), "锁定件位置被移动")
            self.assertTrue(locked[0]["locked"])
            assert_layout_valid(self, lay, 16)


class TestGrainRotationRules(unittest.TestCase):
    """缺陷3：统一纹理与旋转约束"""

    def test_vertical_grain_requires_rotatable(self):
        # rotatable=False + 纵向纹理 → 不能为满足纹理而旋转 → 无解
        self.assertEqual(
            orientations({"w": 100, "h": 200, "rotatable": False, "grain": "vertical"}), [])
        # rotatable=True → 允许旋转 90°
        self.assertEqual(
            orientations({"w": 100, "h": 200, "rotatable": True, "grain": "vertical"}),
            [(200, 100, True)])
        # 横向纹理永不旋转
        self.assertEqual(
            orientations({"w": 100, "h": 200, "rotatable": True, "grain": "horizontal"}),
            [(100, 200, False)])

    def test_nonrotatable_vertical_part_unplaced(self):
        payload = {
            "settings": dict(SETTINGS),
            "sheets": [{"id": "S1", "name": "板", "width": 1000, "height": 1000,
                        "grain": "none", "quantity": 1}],
            "parts": [{"id": "P1", "name": "异形", "width": 100, "height": 200,
                       "quantity": 1, "rotatable": False, "grain": "vertical"}],
        }
        lay = generate_layouts(payload)["layouts"][0]
        self.assertEqual(lay["stats"]["placedCount"], 0)
        self.assertEqual(lay["stats"]["unplacedCount"], 1)
        reason = lay["unplaced"][0]["reason"]
        self.assertIn("纹理", reason)
        self.assertIn("不可旋转", reason)

    def test_sheet_grain_participates(self):
        # 纵向纹理零件 vs 横向纹理板材 → 不可放置并说明原因
        payload = {
            "settings": dict(SETTINGS),
            "sheets": [{"id": "S1", "name": "横纹板", "width": 1000, "height": 1000,
                        "grain": "horizontal", "quantity": 1}],
            "parts": [{"id": "P1", "name": "纵纹件", "width": 100, "height": 200,
                       "quantity": 1, "rotatable": True, "grain": "vertical"}],
        }
        lay = generate_layouts(payload)["layouts"][0]
        self.assertEqual(lay["stats"]["unplacedCount"], 1)
        reason = lay["unplaced"][0]["reason"]
        self.assertIn("纹理", reason)
        self.assertIn("冲突", reason)

        # 增加纵向纹理板材 → 可放置，按纹理要求旋转 90°，且放在纵纹板上
        payload["sheets"].append({"id": "S2", "name": "纵纹板", "width": 1000,
                                  "height": 1000, "grain": "vertical", "quantity": 1})
        lay = generate_layouts(payload)["layouts"][0]
        self.assertEqual(lay["stats"]["unplacedCount"], 0)
        placed = [(s, p) for s in lay["sheets"] for p in s["placements"] if p["partId"] == "P1"]
        self.assertEqual(len(placed), 1)
        sheet, p = placed[0]
        self.assertEqual(sheet["sheetId"], "S2")
        self.assertTrue(p["rotated"])
        self.assertEqual((p["w"], p["h"]), (200, 100))

    def test_sheet_grain_none_accepts_all(self):
        payload = {
            "settings": dict(SETTINGS),
            "sheets": [{"id": "S1", "name": "板", "width": 1000, "height": 1000,
                        "grain": "none", "quantity": 1}],
            "parts": [
                {"id": "P1", "name": "a", "width": 100, "height": 200, "quantity": 1,
                 "rotatable": True, "grain": "vertical"},
                {"id": "P2", "name": "b", "width": 100, "height": 200, "quantity": 1,
                 "rotatable": True, "grain": "horizontal"},
            ],
        }
        lay = generate_layouts(payload)["layouts"][0]
        self.assertEqual(lay["stats"]["unplacedCount"], 0)

    def test_mixed_grain_sheets_route_parts(self):
        # 两种纹理的板材：零件应按纹理匹配落板
        payload = {
            "settings": dict(SETTINGS),
            "sheets": [
                {"id": "SH", "name": "横纹板", "width": 1000, "height": 1000,
                 "grain": "horizontal", "quantity": 1},
                {"id": "SV", "name": "纵纹板", "width": 1000, "height": 1000,
                 "grain": "vertical", "quantity": 1},
            ],
            "parts": [
                {"id": "PH", "name": "横纹件", "width": 100, "height": 200, "quantity": 1,
                 "rotatable": True, "grain": "horizontal"},
                {"id": "PV", "name": "纵纹件", "width": 100, "height": 200, "quantity": 1,
                 "rotatable": True, "grain": "vertical"},
            ],
        }
        lay = generate_layouts(payload)["layouts"][0]
        self.assertEqual(lay["stats"]["unplacedCount"], 0)
        where = {}
        for s in lay["sheets"]:
            for p in s["placements"]:
                where[p["partId"]] = s["sheetId"]
        self.assertEqual(where.get("PH"), "SH")
        self.assertEqual(where.get("PV"), "SV")


class TestProjectApi(unittest.TestCase):
    """保存 / 恢复 / 删除流程回归（SQLite，使用临时库）"""

    def setUp(self):
        import app as flask_app
        self.flask_app = flask_app
        fd, self.tmp = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.orig_db = flask_app.DB_PATH
        flask_app.DB_PATH = self.tmp
        flask_app.init_db()
        self.client = flask_app.app.test_client()

    def tearDown(self):
        self.flask_app.DB_PATH = self.orig_db
        os.unlink(self.tmp)

    def test_save_load_delete(self):
        data = {"settings": {"kerf": 3}, "sheets": [{"id": "S1"}],
                "parts": [], "layouts": [], "active": 0}
        r = self.client.post("/api/projects", json={"name": "回归", "data": data})
        self.assertEqual(r.status_code, 200)
        pid = r.get_json()["id"]
        r = self.client.get(f"/api/projects/{pid}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["data"]["settings"]["kerf"], 3)
        self.assertEqual(r.get_json()["data"]["sheets"][0]["id"], "S1")
        r = self.client.get("/api/projects")
        self.assertTrue(any(p["id"] == pid for p in r.get_json()))
        # 更新（继续编辑后保存）
        data["settings"]["kerf"] = 5
        r = self.client.post("/api/projects", json={"id": pid, "name": "回归", "data": data})
        self.assertEqual(r.get_json()["id"], pid)
        r = self.client.get(f"/api/projects/{pid}")
        self.assertEqual(r.get_json()["data"]["settings"]["kerf"], 5)
        r = self.client.delete(f"/api/projects/{pid}")
        self.assertEqual(r.get_json()["ok"], True)
        r = self.client.get(f"/api/projects/{pid}")
        self.assertEqual(r.status_code, 404)

    def test_nest_endpoint(self):
        r = self.client.post("/api/nest", json=sample_payload())
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["layouts"])
        self.assertEqual(body["layouts"][0]["stats"]["unplacedCount"], 0)


class TestDefectAvoidance(unittest.TestCase):
    """板面缺陷避让：安全外扩 / 等级 / 面别 / 容许区 / 冲突解释 / 统计"""

    def base(self, **over):
        p = {
            "settings": {"kerf": 3, "margin": 5, "spacing": 2},
            "sheets": [{"id": "S1", "name": "板", "width": 1000, "height": 500,
                        "grain": "none", "quantity": 1}],
            "parts": [{"id": "P1", "name": "件", "width": 300, "height": 200,
                       "quantity": 4, "rotatable": True, "grain": "none",
                       "faceReq": "front", "allowGrade": 0}],
            "defects": {},
        }
        p.update(over)
        return p

    def rect_defect(self, **over):
        d = {"id": "D1", "type": "knot", "grade": 3, "face": "front",
             "clearance": 30, "shape": "rect",
             "points": [{"x": 100, "y": 100}, {"x": 260, "y": 260}]}
        d.update(over)
        return d

    def test_rect_defect_keeps_clearance(self):
        p = self.base(defects={"S1#0": [self.rect_defect()]})
        lay = generate_layouts(p)["layouts"][0]
        # 禁入框：核心 (100,100)-(260,260) 外扩 30 → (70,70)-(290,290)
        for s in lay["sheets"]:
            for q in s["placements"]:
                overlap = (q["x"] < 290 - 1e-6 and q["x"] + q["w"] > 70 + 1e-6 and
                           q["y"] < 290 - 1e-6 and q["y"] + q["h"] > 70 + 1e-6)
                self.assertFalse(overlap, f"{q['uid']} 侵入缺陷安全外扩区")
        self.assertEqual(lay["stats"]["qualifiedCount"], 4)
        self.assertGreater(lay["stats"]["defectScrap"], 0)

    def test_polygon_defect_distance(self):
        from nesting import rect_poly_dist, _pt
        d = {"id": "D9", "type": "scratch", "grade": 2, "face": "front",
             "clearance": 10, "shape": "poly",
             "points": [{"x": 200, "y": 200}, {"x": 350, "y": 200}, {"x": 200, "y": 350}]}
        p = self.base(
            sheets=[{"id": "S1", "name": "板", "width": 500, "height": 500,
                     "grain": "none", "quantity": 1}],
            parts=[{"id": "P1", "name": "件", "width": 100, "height": 100,
                    "quantity": 3, "rotatable": False, "grain": "none",
                    "faceReq": "front", "allowGrade": 0}],
            defects={"S1#0": [d]})
        lay = generate_layouts(p)["layouts"][0]
        self.assertEqual(lay["stats"]["unplacedCount"], 0)
        tri = [_pt(q) for q in d["points"]]
        for q in lay["sheets"][0]["placements"]:
            self.assertGreaterEqual(
                rect_poly_dist(q["x"], q["y"], q["w"], q["h"], tri), 10 - 1e-6,
                f"{q['uid']} 与多边形缺陷净距不足")

    def test_grade_tolerance(self):
        # 联合条件：等级达标 + 缺陷核心整体在容许区内，两者同时满足才放行。
        whole_zone = [{"points": [{"x": 0, "y": 0}, {"x": 300, "y": 0},
                                  {"x": 300, "y": 200}, {"x": 0, "y": 200}]}]
        small_d = self.rect_defect(points=[{"x": 120, "y": 120}, {"x": 200, "y": 180}])
        # ≤3 级 + 整件容许区 → 覆盖小缺陷，零件可放左上角且全部合格
        p_ok = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=3, allowZones=whole_zone)],
            defects={"S1#0": [small_d]})
        ps = generate_layouts(p_ok)["layouts"][0]["sheets"][0]["placements"]
        self.assertTrue(any(q["x"] == 5 and q["y"] == 5 for q in ps))
        self.assertEqual(generate_layouts(p_ok)["layouts"][0]["stats"]["qualifiedCount"], 4)

        # 容许区外的 1 级缺陷：allowGrade=1 但无容许区覆盖 → 仍避让（旧逻辑错误放行）
        p_out = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=1)],
            defects={"S1#0": [self.rect_defect(grade=1)]})
        for q in generate_layouts(p_out)["layouts"][0]["sheets"][0]["placements"]:
            self.assertFalse(q["x"] < 290 and q["x"] + q["w"] > 70 and
                             q["y"] < 290 and q["y"] + q["h"] > 70)

        # 容许区内但 3 级 > 允许 1 级 → 不满足联合条件，仍避让
        p_over = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=1, allowZones=whole_zone)],
            defects={"S1#0": [dict(small_d, grade=3)]})
        ps_over = generate_layouts(p_over)["layouts"][0]["sheets"][0]["placements"]
        self.assertFalse(any(q["x"] == 5 and q["y"] == 5 for q in ps_over))

        # 允许 ≤1 级 → 仍避让容许区外的 3 级大缺陷（回归）
        p_no = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=1)],
            defects={"S1#0": [self.rect_defect()]})
        for q in generate_layouts(p_no)["layouts"][0]["sheets"][0]["placements"]:
            self.assertFalse(q["x"] < 290 and q["x"] + q["w"] > 70 and
                             q["y"] < 290 and q["y"] + q["h"] > 70)

    def test_zero_clearance_core_overlap_blocks(self):
        from nesting import rect_poly_overlap
        sq = [(100, 100), (200, 100), (200, 200), (100, 200)]
        # 严格重叠阻止；外切/点接触不阻止；完全重合按重叠处理
        self.assertTrue(rect_poly_overlap(110, 110, 50, 50, sq))
        self.assertFalse(rect_poly_overlap(50, 100, 50, 100, sq))   # 右边外切 x=100
        self.assertTrue(rect_poly_overlap(100, 100, 100, 100, sq))  # 完全重合
        payload = {
            "settings": {"kerf": 3, "margin": 0, "spacing": 0},
            "sheets": [{"id": "S1", "name": "板", "width": 600, "height": 600,
                        "grain": "none", "quantity": 1}],
            "parts": [{"id": "P1", "name": "件", "width": 200, "height": 100,
                       "quantity": 1, "rotatable": False, "grain": "none",
                       "faceReq": "front", "allowGrade": 0}],
            "defects": {"S1#0": [{"id": "D1", "type": "knot", "grade": 3,
                                  "face": "front", "clearance": 0, "shape": "poly",
                                  "points": [{"x": x, "y": y} for x, y in sq]}]},
        }
        lay = generate_layouts(payload)["layouts"][0]
        for q in lay["sheets"][0]["placements"]:
            self.assertFalse(rect_poly_overlap(q["x"], q["y"], q["w"], q["h"], sq),
                             "零外扩缺陷核心被零件压住")

    def test_both_face_defect_blocks_any_part(self):
        from nesting import face_conflict
        # 双面/贯穿缺陷：正反面均可（any）的零件也无法靠翻板避开
        self.assertTrue(face_conflict("both", "any"))
        self.assertFalse(face_conflict("front", "any"))
        payload = {
            "settings": {"kerf": 3, "margin": 0, "spacing": 0},
            "sheets": [{"id": "S1", "name": "板", "width": 600, "height": 600,
                        "grain": "none", "quantity": 1}],
            "parts": [{"id": "P1", "name": "件", "width": 100, "height": 100,
                       "quantity": 1, "rotatable": False, "grain": "none",
                       "faceReq": "any", "allowGrade": 0}],
            "defects": {"S1#0": [{"id": "D1", "type": "knot", "grade": 3,
                                  "face": "both", "clearance": 0, "shape": "poly",
                                  "points": [{"x": x, "y": y} for x, y in
                                             [(100, 100), (200, 100), (200, 200), (100, 200)]]}]},
        }
        lay = generate_layouts(payload)["layouts"][0]
        from nesting import rect_poly_overlap
        for q in lay["sheets"][0]["placements"]:
            self.assertFalse(
                rect_poly_overlap(q["x"], q["y"], q["w"], q["h"],
                                  [(100, 100), (200, 100), (200, 200), (100, 200)]))

    def test_face_meeting(self):
        from nesting import face_conflict
        # any 面要求永不冲突；both 缺陷对任何单面要求都冲突
        self.assertFalse(face_conflict("front", "any"))
        self.assertTrue(face_conflict("both", "front"))
        self.assertTrue(face_conflict("front", "both"))
        self.assertFalse(face_conflict("back", "front"))
        self.assertTrue(face_conflict("front", "front"))
        # 缺陷在反面、零件要求正面 → 不避让，可放左上角
        p = self.base(defects={"S1#0": [self.rect_defect(face="back")]})
        q0 = generate_layouts(p)["layouts"][0]["sheets"][0]["placements"][0]
        self.assertEqual((q0["x"], q0["y"]), (5, 5))

    def test_allowzone_exempts_contained_defect(self):
        # 小缺陷整体可落入第一个零件内部 + 整件容许区 + 等级达标 → 可放左上角且合格
        p = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=3, allowZones=[
                {"points": [{"x": 0, "y": 0}, {"x": 300, "y": 0},
                            {"x": 300, "y": 200}, {"x": 0, "y": 200}]}])],
            defects={"S1#0": [self.rect_defect(
                points=[{"x": 120, "y": 120}, {"x": 200, "y": 180}])]})
        lay = generate_layouts(p)["layouts"][0]
        ps = lay["sheets"][0]["placements"]
        self.assertTrue(any(q["x"] == 5 and q["y"] == 5 for q in ps))
        self.assertEqual(lay["stats"]["qualifiedCount"], 4)
        # 有容许区但允许等级 0（不容许任何缺陷）→ 仍避让
        p0 = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=0, allowZones=[
                {"points": [{"x": 0, "y": 0}, {"x": 300, "y": 0},
                            {"x": 300, "y": 200}, {"x": 0, "y": 200}]}])],
            defects={"S1#0": [self.rect_defect(
                points=[{"x": 120, "y": 120}, {"x": 200, "y": 180}])]})
        ps0 = generate_layouts(p0)["layouts"][0]["sheets"][0]["placements"]
        self.assertFalse(any(q["x"] == 5 and q["y"] == 5 for q in ps0))
        # 容许区仅左 50mm，缺陷 x∈[120,200] → 不豁免，仍避让
        p2 = self.base(
            parts=[dict(self.base()["parts"][0], allowGrade=3, allowZones=[
                {"points": [{"x": 0, "y": 0}, {"x": 50, "y": 0},
                            {"x": 50, "y": 200}, {"x": 0, "y": 200}]}])],
            defects={"S1#0": [self.rect_defect(
                points=[{"x": 120, "y": 120}, {"x": 200, "y": 180}])]})
        ps2 = generate_layouts(p2)["layouts"][0]["sheets"][0]["placements"]
        self.assertFalse(any(q["x"] == 5 and q["y"] == 5 for q in ps2))

    def test_unavoidable_reason_names_sheet_and_defect(self):
        p = {
            "settings": {"kerf": 3, "margin": 5, "spacing": 2},
            "sheets": [{"id": "S1", "name": "板", "width": 300, "height": 300,
                        "grain": "none", "quantity": 1}],
            "parts": [{"id": "P1", "name": "大件", "width": 250, "height": 250,
                       "quantity": 1, "rotatable": False, "grain": "none",
                       "faceReq": "front", "allowGrade": 0}],
            "defects": {"S1#0": [{
                "id": "D1", "type": "crack", "grade": 2, "face": "front",
                "clearance": 40, "shape": "poly",
                "points": [{"x": 130, "y": 130}, {"x": 170, "y": 130},
                           {"x": 170, "y": 170}, {"x": 130, "y": 170}]}]},
        }
        u = generate_layouts(p)["layouts"][0]["unplaced"][0]
        self.assertIn("无法避让", u["reason"])
        self.assertIn("S1", u["reason"])
        self.assertIn("D1", u["reason"])
        self.assertEqual(u["conflicts"][0]["sheetId"], "S1")
        self.assertIn("D1", u["conflicts"][0]["defects"][0])
        # 精确定位：conflicts 携带实际冲突缺陷 id（提示文案与定位对象一致）
        self.assertEqual(u["conflicts"][0]["defectIds"], ["D1"])

    def test_locked_part_on_defect_flagged_unqualified(self):
        p = {
            "settings": {"kerf": 3, "margin": 5, "spacing": 2},
            "sheets": [{"id": "S1", "name": "板", "width": 300, "height": 300,
                        "grain": "none", "quantity": 1}],
            "parts": [{"id": "P1", "name": "件", "width": 100, "height": 100,
                       "quantity": 1, "rotatable": False, "grain": "none",
                       "faceReq": "front", "allowGrade": 0}],
            "defects": {"S1#0": [self.rect_defect(
                points=[{"x": 130, "y": 130}, {"x": 170, "y": 170}], clearance=20)]},
            "locked": {"0": [{"uid": "P1#1", "partId": "P1", "x": 100, "y": 100,
                              "w": 100, "h": 100, "rotated": False}]},
        }
        lay = generate_layouts(p)["layouts"][0]
        self.assertEqual(lay["stats"]["qualifiedCount"], 0)
        self.assertEqual(lay["conflicts"][0]["defectIds"], ["D1"])

    def test_defects_per_instance_independent(self):
        # 两张同定义板：仅 #1 有缺陷 → 零件优先装满无缺陷的 #0
        p = self.base(
            sheets=[{"id": "S1", "name": "板", "width": 1000, "height": 500,
                     "grain": "none", "quantity": 2}],
            defects={"S1#1": [self.rect_defect(clearance=50)]})
        lay = generate_layouts(p)["layouts"][0]
        s0, s1 = lay["sheets"]
        self.assertEqual(len(s1["placements"]), 0)
        self.assertEqual(len(s0["placements"]), 4)
        # 避让碎料只统计方案所用板材：#1 未使用 → 合计 0，#1 单板字段也为 0
        self.assertEqual(lay["stats"]["defectScrap"], 0)
        self.assertEqual(s1["defectScrap"], 0)
        # 已用缺陷板则计入：缺陷放在 #0 且 #0 被使用 → 合计 > 0
        p2 = self.base(
            sheets=[{"id": "S1", "name": "板", "width": 1000, "height": 500,
                     "grain": "none", "quantity": 2}],
            defects={"S1#0": [self.rect_defect(clearance=50)]})
        lay2 = generate_layouts(p2)["layouts"][0]
        self.assertGreater(lay2["stats"]["defectScrap"], 0)
        self.assertEqual(lay2["sheets"][1]["defectScrap"], 0)  # 未使用板为 0

    def test_defect_persisted_via_project_api(self):
        import app as flask_app
        fd, tmp = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        orig = flask_app.DB_PATH
        flask_app.DB_PATH = tmp
        flask_app.init_db()
        try:
            client = flask_app.app.test_client()
            defects = {"S1#0": [self.rect_defect()]}
            data = {"settings": {"kerf": 3}, "sheets": [{"id": "S1"}],
                    "parts": [], "defects": defects, "layouts": [], "active": 0}
            pid = client.post("/api/projects", json={"name": "带缺陷", "data": data}).get_json()["id"]
            got = client.get(f"/api/projects/{pid}").get_json()["data"]["defects"]
            self.assertEqual(got["S1#0"][0]["id"], "D1")
            self.assertEqual(got["S1#0"][0]["clearance"], 30)
        finally:
            flask_app.DB_PATH = orig
            os.unlink(tmp)


if __name__ == "__main__":
    unittest.main()
