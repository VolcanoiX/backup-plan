import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["BACKUP_PLAN_DATA"] = str(Path(self.tmp.name) / "data.json")
        import app as app_module
        self.app_module = importlib.reload(app_module)
        self.client = self.app_module.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop("BACKUP_PLAN_DATA", None)

    # helpers
    def post(self, url, payload=None, status=200):
        r = self.client.post(url, json=payload or {})
        self.assertEqual(r.status_code, status, r.get_json())
        return r.get_json()

    def put(self, url, payload=None, status=200):
        r = self.client.put(url, json=payload or {})
        self.assertEqual(r.status_code, status, r.get_json())
        return r.get_json()

    def delete(self, url, status=200):
        r = self.client.delete(url)
        self.assertEqual(r.status_code, status, r.get_json())
        return r.get_json()

    def make_org(self, name="Рога и Копыта", tag="RIK"):
        return self.post("/api/orgs", {"name": name, "tag": tag})["id"]

    # tests
    def test_org_tag_normalized_and_unique(self):
        oid = self.make_org(tag="RIK")
        data = self.client.get("/api/data").get_json()
        self.assertEqual(data["organizations"][0]["tag"], "#RIK")
        self.post("/api/orgs", {"name": "Другая", "tag": "#rik"}, status=409)
        self.put(f"/api/orgs/{oid}", {"name": "Рога и Копыта 2", "tag": "#RIK"})

    def test_org_color(self):
        oid = self.post("/api/orgs", {"name": "A", "tag": "A", "color": "teal"})["id"]
        org = self.client.get("/api/data").get_json()["organizations"][0]
        self.assertEqual(org["color"], "teal")
        # не код цвета — сбрасывается в «авто»
        res = self.put(f"/api/orgs/{oid}", {"name": "A", "tag": "A", "color": "#ff0000"})
        self.assertEqual(res["data"]["organizations"][0]["color"], "")

    def test_dict_icons(self):
        kinds = self.client.get("/api/dicts").get_json()["dicts"]["device_kinds"]
        self.assertEqual(kinds[0]["icon"], "server")
        items = [dict(k) for k in kinds]
        items[0]["icon"] = "cpu"
        items[1]["icon"] = "<svg>"
        new = self.put("/api/dicts/device_kinds", {"items": items})["dicts"]["device_kinds"]
        self.assertEqual(new[0]["icon"], "cpu")
        self.assertEqual(new[1]["icon"], "")

    def test_name_required(self):
        self.post("/api/orgs", {"name": "  "}, status=400)

    def test_storage_created_from_org_gets_access(self):
        oid = self.make_org()
        res = self.post(f"/api/orgs/{oid}/storages", {"name": "NAS-01", "type": "nas", "scope": "local"})
        st = next(s for s in res["data"]["storages"] if s["id"] == res["id"])
        self.assertEqual(st["org_ids"], [oid])

    def test_set_copies_validation_and_access_rules(self):
        org_a = self.make_org("A", "A")
        org_b = self.make_org("B", "B")
        nas = self.post(f"/api/orgs/{org_a}/storages", {"name": "NAS", "scope": "local"})["id"]
        s3 = self.post("/api/storages", {"name": "S3", "scope": "remote", "org_ids": [org_a, org_b]})["id"]
        dev = self.post(f"/api/orgs/{org_a}/devices", {"name": "SRV"})["id"]
        dev_b = self.post(f"/api/orgs/{org_b}/devices", {"name": "SRV-B"})["id"]

        # хранилище без доступа у организации B
        self.post(f"/api/devices/{dev_b}/sets", {"name": "x", "type": "folder",
                                                 "copies": [{"storage_id": nas, "from": "source"}]}, status=400)

        res = self.post(f"/api/devices/{dev}/sets", {"name": "1C", "type": "db1c", "copies": [
            {"id": "cp_1", "storage_id": nas, "from": "source", "schedule": "23:00"},
            {"id": "cp_2", "storage_id": s3, "from": "cp_1"},
        ]})
        set_id = res["id"]

        # цикл
        self.put(f"/api/sets/{set_id}", {"name": "1C", "type": "db1c", "copies": [
            {"id": "cp_1", "storage_id": nas, "from": "cp_2"},
            {"id": "cp_2", "storage_id": s3, "from": "cp_1"},
        ]}, status=400)
        # ссылка на несуществующую копию
        self.put(f"/api/sets/{set_id}", {"name": "1C", "type": "db1c", "copies": [
            {"id": "cp_1", "storage_id": nas, "from": "cp_x"}]}, status=400)

        # снять доступ A к S3 нельзя — используется
        r = self.put(f"/api/storages/{s3}", {"name": "S3", "scope": "remote", "org_ids": [org_b]}, status=409)
        self.assertEqual(len(r["usages"]), 1)
        self.delete(f"/api/orgs/{org_a}/storages/{s3}", status=409)
        self.delete(f"/api/storages/{s3}", status=409)
        # а у B можно
        self.delete(f"/api/orgs/{org_b}/storages/{s3}")

        # после удаления набора хранилище можно удалить
        self.delete(f"/api/sets/{set_id}")
        self.delete(f"/api/storages/{s3}")

    def test_delete_org_removes_access(self):
        oid = self.make_org()
        sid = self.post(f"/api/orgs/{oid}/storages", {"name": "NAS"})["id"]
        data = self.delete(f"/api/orgs/{oid}")["data"]
        self.assertEqual(data["organizations"], [])
        self.assertEqual(data["storages"][0]["id"], sid)
        self.assertEqual(data["storages"][0]["org_ids"], [])

    def test_dicts_defaults_and_meta(self):
        res = self.client.get("/api/dicts").get_json()
        self.assertIn("tools", res["dicts"])
        self.assertEqual(res["schema"]["set_types"]["kind"], "choice")
        meta = self.client.get("/api/meta").get_json()
        self.assertEqual(meta["storage_types"]["nas"], "NAS")
        self.assertIn("remote", meta["storage_scopes"])
        # пока справочники не меняли, файл не создаётся
        self.assertFalse((Path(self.tmp.name) / "dictionaries.json").exists())

    def test_dict_list_update(self):
        res = self.put("/api/dicts/tools", {"items": [" robocopy ", "Robocopy", "", "restic"]})
        self.assertEqual(res["dicts"]["tools"], ["robocopy", "restic"])
        self.assertTrue((Path(self.tmp.name) / "dictionaries.json").exists())
        self.put("/api/dicts/nope", {"items": []}, status=404)
        self.put("/api/dicts/tools", {"items": "x"}, status=400)

    def test_dict_choice_update_and_usage_protection(self):
        oid = self.make_org()
        dev = self.post(f"/api/orgs/{oid}/devices", {"name": "SRV", "kind": "vm"})["id"]
        self.post(f"/api/devices/{dev}/sets", {"name": "Docs", "type": "folder"})
        kinds = self.client.get("/api/dicts").get_json()["dicts"]["device_kinds"]

        # новое значение получает id, переименование сохраняет id
        items = [dict(k) for k in kinds] + [{"label": "Контейнер", "short": "CT"}]
        items[0]["label"] = "Железный сервер"
        res = self.put("/api/dicts/device_kinds", {"items": items})
        new = res["dicts"]["device_kinds"]
        self.assertEqual(new[0]["id"], "physical")
        self.assertEqual(new[0]["label"], "Железный сервер")
        added = new[-1]["id"]
        self.post(f"/api/orgs/{oid}/devices", {"name": "CT-1", "kind": added})

        # удалить используемое значение нельзя
        without_vm = [k for k in new if k["id"] != "vm"]
        r = self.put("/api/dicts/device_kinds", {"items": without_vm}, status=409)
        self.assertEqual(len(r["usages"]), 1)
        # неиспользуемое — можно, после этого значение больше не принимается
        self.put("/api/dicts/device_kinds", {"items": [k for k in new if k["id"] != "nas"]})
        self.post(f"/api/orgs/{oid}/devices", {"name": "X", "kind": "nas"}, status=400)

        # повтор названия и пустой справочник запрещены
        self.put("/api/dicts/set_types", {"items": [{"label": "A"}, {"label": "a"}]}, status=400)
        self.put("/api/dicts/storage_types", {"items": []}, status=400)

    def test_copy_specs(self):
        oid = self.make_org()
        nas = self.post(f"/api/orgs/{oid}/storages", {"name": "NAS"})["id"]
        dev = self.post(f"/api/orgs/{oid}/devices", {"name": "SRV"})["id"]
        res = self.post(f"/api/devices/{dev}/sets", {"name": "1C", "type": "db1c", "copies": [{
            "storage_id": nas, "schedule": "ежедневно в 23:00",
            "schedule_spec": {"kind": "days", "days": [1, 2, 3, 4, 5, 6, 7], "times": ["23:00"], "x": {"a": 1}},
            "retention": "14 дней", "retention_spec": {"kind": "period", "n": 14, "unit": "day"},
        }]})
        copy = res["data"]["organizations"][0]["devices"][0]["sets"][0]["copies"][0]
        self.assertEqual(copy["schedule_spec"], {"kind": "days", "days": [1, 2, 3, 4, 5, 6, 7], "times": ["23:00"]})
        self.assertEqual(copy["retention_spec"]["n"], 14)
        self.post(f"/api/devices/{dev}/sets", {"name": "y", "copies": [
            {"storage_id": nas, "schedule_spec": {"kind": "weird"}}]}, status=400)

    def test_copy_stage(self):
        oid = self.make_org()
        nas = self.post(f"/api/orgs/{oid}/storages", {"name": "NAS"})["id"]
        dev = self.post(f"/api/orgs/{oid}/devices", {"name": "SRV"})["id"]
        res = self.post(f"/api/devices/{dev}/sets", {"name": "1C", "copies": [
            {"storage_id": nas}, {"storage_id": nas, "stage": "approval"}]})
        copies = res["data"]["organizations"][0]["devices"][0]["sets"][0]["copies"]
        self.assertEqual([c["stage"] for c in copies], ["active", "approval"])
        self.post(f"/api/devices/{dev}/sets", {"name": "x", "copies": [
            {"storage_id": nas, "stage": "done"}]}, status=400)
        self.assertIn("planned", self.client.get("/api/dicts").get_json()["copy_stages"])

    def test_backups_created(self):
        self.make_org("A", "A")
        self.make_org("B", "B")
        backups = list((Path(self.tmp.name) / "backups").glob("data-*.json"))
        self.assertGreaterEqual(len(backups), 1)


if __name__ == "__main__":
    unittest.main()
