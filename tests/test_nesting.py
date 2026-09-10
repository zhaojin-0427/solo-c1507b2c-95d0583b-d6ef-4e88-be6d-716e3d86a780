"""排样引擎与后端 API 回归测试。

覆盖：
- 既有排样能力（无重叠/越界、间距满足、数量守恒）—— 回归
- 锁定重排保持 —— 回归
- 保存/恢复/删除 API —— 回归
- 缺陷3：rotatable=False 不为满足纹理而旋转；原料板纹理参与放置判断；
  无法满足时列入未放置并说明原因

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


if __name__ == "__main__":
    unittest.main()
