"""План резервного копирования — локальный веб-справочник.

Запуск:  python app.py   →   http://127.0.0.1:8765
"""
from __future__ import annotations

import copy as copylib
import json
import os
import re
import shutil
import threading
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from store import Store, new_id

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("BACKUP_PLAN_DATA", BASE_DIR / "data" / "data.json"))
DICT_FILE = DATA_FILE.parent / "dictionaries.json"
BACKUP_DIR = DATA_FILE.parent / "backups"
DEMO_FILE = BASE_DIR / "demo_data.json"
DICT_DEFAULT_FILE = BASE_DIR / "dictionaries_default.json"

HOST = os.environ.get("BACKUP_PLAN_HOST", "127.0.0.1")
PORT = int(os.environ.get("BACKUP_PLAN_PORT") or os.environ.get("PORT") or "8765")

# --- справочники -------------------------------------------------------------
# Размещение хранилища — системное значение: от него зависит статус «нет offsite»,
# поэтому в редактируемые справочники оно не входит.
STORAGE_SCOPES = {
    "local": "Локальное",
    "remote": "Удалённое (offsite)",
}

# Статус копии — тоже системный: защитой считаются только действующие копии.
# Копии без поля (созданные до появления статусов) считаются действующими.
COPY_STAGES = {
    "approval": "Согласование",
    "planned": "В плане",
    "active": "Действует",
}

# choice — значения с кодом (в данных хранится id), list — просто подсказки для ввода
DICT_SCHEMA = {
    "set_types": {
        "title": "Что копируем",
        "kind": "choice",
        "about": "Тип набора. Подсказка появляется в поле «Источник».",
        "fields": {"icon": "Значок", "hint": "Подсказка для поля «Источник»"},
    },
    "storage_types": {
        "title": "Типы хранилищ",
        "kind": "choice",
        "about": "Тип в карточке хранилища: NAS, сетевая папка, облако…",
        "fields": {"icon": "Значок"},
    },
    "device_kinds": {
        "title": "Типы устройств",
        "kind": "choice",
        "about": "Сервер, ВМ, ПК… Краткое название показывается в плане организации.",
        "fields": {"icon": "Значок", "short": "Кратко в плане"},
    },
    "tools": {
        "title": "Инструменты",
        "kind": "list",
        "about": "Подсказки для поля «Инструмент» в копиях.",
    },
    "os": {
        "title": "Операционные системы",
        "kind": "list",
        "about": "Подсказки для поля «ОС» устройства.",
    },
    "roles": {
        "title": "Роли устройств",
        "kind": "list",
        "about": "Подсказки для поля «Роль» устройства.",
    },
    "hypervisors": {
        "title": "Гипервизоры",
        "kind": "list",
        "about": "Подсказки для поля «Гипервизор / хост» устройства.",
    },
    "locations": {
        "title": "Расположения",
        "kind": "list",
        "about": "Подсказки для полей «Расположение» устройства и «Где находится» хранилища.",
    },
}

with DICT_DEFAULT_FILE.open("r", encoding="utf-8") as _f:
    DEFAULT_DICTS = json.load(_f)

# структурированные расписание и хранение (текст в schedule / retention генерирует интерфейс)
SCHEDULE_KINDS = {"days", "interval", "monthly", "continuous", "after", "manual"}
RETENTION_KINDS = {"period", "count", "gfs", "last", "forever"}

ORG_FIELDS = ("name", "tag", "color", "notes")
DEVICE_FIELDS = ("name", "host", "os", "role", "kind", "hypervisor", "location", "notes")
SET_FIELDS = ("name", "type", "source", "notes")
COPY_FIELDS = ("tool", "schedule", "retention", "notes")
STORAGE_FIELDS = ("name", "type", "scope", "address", "location", "notes")
FIELD_LABELS = {"name": "Название"}

_lock = threading.RLock()
store = Store(DATA_FILE, BACKUP_DIR, lock=_lock)
dict_store = Store(DICT_FILE, BACKUP_DIR, empty={"version": 1, "updated_at": None}, lock=_lock)
app = Flask(__name__, static_folder="static", static_url_path="/static")
app.json.ensure_ascii = False
app.json.sort_keys = False


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.message = message
        self.status = status
        self.extra = extra


@app.errorhandler(ApiError)
def handle_api_error(err: ApiError):
    return jsonify({"error": err.message, **err.extra}), err.status


# --- вспомогательные функции ----------------------------------------------
def body() -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ApiError("Ожидался JSON-объект в теле запроса")
    return payload


def clean_fields(payload: dict, fields: tuple[str, ...], required=("name",)) -> dict:
    result = {}
    for key in fields:
        value = payload.get(key, "")
        if value is None:
            value = ""
        if not isinstance(value, str):
            value = str(value)
        result[key] = value.strip()
    for key in required:
        if not result.get(key):
            raise ApiError(f"Поле «{FIELD_LABELS.get(key, key)}» обязательно")
    return result


def check_choice(value: str, dict_name: str, title: str) -> None:
    if value and value not in choice_map(dict_name):
        raise ApiError(f"Недопустимое значение «{value}» для поля «{title}»")


# --- справочники: чтение и проверка ----------------------------------------
def merge_dicts(stored: dict) -> dict:
    """Сохранённые справочники поверх стандартных (новые справочники берутся из стандартных)."""
    result = {}
    for name in DICT_SCHEMA:
        value = stored.get(name)
        result[name] = value if isinstance(value, list) else copylib.deepcopy(DEFAULT_DICTS.get(name, []))
    return result


def load_dicts() -> dict:
    return merge_dicts(dict_store.load())


def choice_map(dict_name: str) -> dict:
    return {item["id"]: item["label"] for item in load_dicts()[dict_name]}


def dict_usages(data: dict, dict_name: str, item_id: str) -> list[str]:
    """Где используется значение справочника — список подписей для сообщения об ошибке."""
    out = []
    if dict_name == "storage_types":
        out = [st["name"] for st in data["storages"] if st.get("type") == item_id]
    for org in data["organizations"]:
        for dev in org.get("devices", []):
            if dict_name == "device_kinds" and dev.get("kind") == item_id:
                out.append(f"{org['name']} / {dev['name']}")
            for bset in dev.get("sets", []):
                if dict_name == "set_types" and bset.get("type") == item_id:
                    out.append(f"{org['name']} / {dev['name']} / {bset['name']}")
    return out


ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
# значок (имя иконки из набора интерфейса) и цвет аватара — короткие коды; чужое значение сбрасывается
ICON_RE = re.compile(r"^[a-z0-9-]{1,24}$")
COLOR_RE = re.compile(r"^[a-z]{1,20}$")


def clean_choice_items(items: list, schema: dict) -> list[dict]:
    extra = tuple(schema.get("fields", {}))
    result, ids, labels = [], set(), set()
    for idx, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise ApiError(f"Строка №{idx}: неверный формат")
        label = str(raw.get("label") or "").strip()
        if not label:
            raise ApiError(f"Строка №{idx}: укажите название")
        if label.lower() in labels:
            raise ApiError(f"Значение «{label}» повторяется")
        labels.add(label.lower())
        item_id = str(raw.get("id") or "").strip()
        if not ID_RE.match(item_id) or item_id in ids:
            item_id = new_id("opt")
        ids.add(item_id)
        item = {"id": item_id, "label": label}
        for key in extra:
            item[key] = str(raw.get(key) or "").strip()
        if "icon" in item and not ICON_RE.match(item["icon"]):
            item["icon"] = ""
        result.append(item)
    if not result:
        raise ApiError("В справочнике должно остаться хотя бы одно значение")
    return result


def clean_list_items(items: list) -> list[str]:
    result, seen = [], set()
    for raw in items:
        if not isinstance(raw, (str, int, float)):
            raise ApiError("Значения справочника должны быть строками")
        value = str(raw).strip()
        if value and value.lower() not in seen:
            seen.add(value.lower())
            result.append(value)
    return result


def clean_spec(raw, kinds: set, title: str, copy_no: int):
    """Структура расписания или хранения: тип из списка, простые значения, без вложенных объектов."""
    if raw in (None, "", {}):
        return None
    if not isinstance(raw, dict) or raw.get("kind") not in kinds:
        raise ApiError(f"Копия №{copy_no}: неверный формат поля «{title}»")
    spec = {}
    for key, value in list(raw.items())[:20]:
        if not isinstance(key, str) or len(key) > 32:
            continue
        if isinstance(value, (bool, int, float)):
            spec[key] = value
        elif isinstance(value, str):
            spec[key] = value.strip()[:100]
        elif isinstance(value, list):
            spec[key] = [v if isinstance(v, (int, float)) else str(v)[:20]
                         for v in value[:24] if isinstance(v, (str, int, float)) and not isinstance(v, bool)]
    return spec


def find_org(data: dict, org_id: str) -> dict:
    for org in data["organizations"]:
        if org["id"] == org_id:
            return org
    raise ApiError("Организация не найдена", 404)


def find_device(data: dict, device_id: str) -> tuple[dict, dict]:
    for org in data["organizations"]:
        for dev in org.get("devices", []):
            if dev["id"] == device_id:
                return org, dev
    raise ApiError("Устройство не найдено", 404)


def find_set(data: dict, set_id: str) -> tuple[dict, dict, dict]:
    for org in data["organizations"]:
        for dev in org.get("devices", []):
            for bset in dev.get("sets", []):
                if bset["id"] == set_id:
                    return org, dev, bset
    raise ApiError("Набор не найден", 404)


def find_storage(data: dict, storage_id: str) -> dict:
    for st in data["storages"]:
        if st["id"] == storage_id:
            return st
    raise ApiError("Хранилище не найдено", 404)


def storage_usages(data: dict, storage_id: str, org_id: str | None = None) -> list[dict]:
    """Где используется хранилище (опционально — только в одной организации)."""
    usages = []
    for org in data["organizations"]:
        if org_id and org["id"] != org_id:
            continue
        for dev in org.get("devices", []):
            for bset in dev.get("sets", []):
                for idx, copy in enumerate(bset.get("copies", []), start=1):
                    if copy.get("storage_id") == storage_id:
                        usages.append({
                            "org_id": org["id"], "org_name": org["name"],
                            "device_id": dev["id"], "device_name": dev["name"],
                            "set_id": bset["id"], "set_name": bset["name"],
                            "copy_no": idx,
                        })
    return usages


def describe_usages(usages: list[dict]) -> str:
    lines = [f"{u['org_name']} / {u['device_name']} / {u['set_name']} (копия №{u['copy_no']})"
             for u in usages[:10]]
    if len(usages) > 10:
        lines.append(f"…и ещё {len(usages) - 10}")
    return "; ".join(lines)


def check_tag_unique(data: dict, tag: str, own_id: str | None = None) -> None:
    if not tag:
        return
    for org in data["organizations"]:
        if org["id"] != own_id and org.get("tag", "").lower() == tag.lower():
            raise ApiError(f"Тег {tag} уже используется организацией «{org['name']}»", 409)


def clean_org(payload: dict) -> dict:
    fields = clean_fields(payload, ORG_FIELDS)
    fields["tag"] = normalize_tag(fields["tag"])
    if not COLOR_RE.match(fields["color"]):
        fields["color"] = ""
    return fields


def normalize_tag(tag: str) -> str:
    tag = tag.strip().replace(" ", "")
    if tag and not tag.startswith("#"):
        tag = "#" + tag
    return tag


def clean_copies(data: dict, org: dict, raw_copies) -> list[dict]:
    if raw_copies is None:
        return []
    if not isinstance(raw_copies, list):
        raise ApiError("Список копий должен быть массивом")

    copies, seen_ids = [], set()
    for idx, raw in enumerate(raw_copies, start=1):
        if not isinstance(raw, dict):
            raise ApiError(f"Копия №{idx}: неверный формат")
        copy_id = str(raw.get("id") or "").strip() or new_id("cp")
        if copy_id in seen_ids:
            copy_id = new_id("cp")
        seen_ids.add(copy_id)

        storage_id = str(raw.get("storage_id") or "").strip()
        if not storage_id:
            raise ApiError(f"Копия №{idx}: выберите хранилище")
        storage = next((s for s in data["storages"] if s["id"] == storage_id), None)
        if storage is None:
            raise ApiError(f"Копия №{idx}: хранилище не найдено")
        if org["id"] not in storage.get("org_ids", []):
            raise ApiError(f"Копия №{idx}: хранилище «{storage['name']}» не доступно "
                           f"организации «{org['name']}»")

        copy = {"id": copy_id, "storage_id": storage_id,
                "from": str(raw.get("from") or "source").strip() or "source"}
        stage = str(raw.get("stage") or "active").strip()
        if stage not in COPY_STAGES:
            raise ApiError(f"Копия №{idx}: недопустимый статус «{stage}»")
        copy["stage"] = stage
        copy.update(clean_fields(raw, COPY_FIELDS, required=()))
        for key, kinds, title in (("schedule_spec", SCHEDULE_KINDS, "Расписание"),
                                  ("retention_spec", RETENTION_KINDS, "Хранение")):
            spec = clean_spec(raw.get(key), kinds, title, idx)
            if spec:
                copy[key] = spec
        copies.append(copy)

    # проверка ссылок «откуда копируем»: только source или другая копия этого набора, без циклов
    by_id = {c["id"]: c for c in copies}
    number = {c["id"]: i for i, c in enumerate(copies, start=1)}
    for c in copies:
        if c["from"] == "source":
            continue
        if c["from"] == c["id"]:
            raise ApiError(f"Копия №{number[c['id']]} не может копироваться сама из себя")
        if c["from"] not in by_id:
            raise ApiError(f"Копия №{number[c['id']]}: исходная копия не найдена")
        visited, cur = {c["id"]}, c["from"]
        while cur != "source":
            if cur in visited:
                raise ApiError(f"Копия №{number[c['id']]}: цепочка копий зациклена")
            visited.add(cur)
            cur = by_id[cur]["from"]
    return copies


def ok(data: dict, **extra):
    return jsonify({"ok": True, "data": data, **extra})


# --- статика ---------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# --- чтение ------------------------------------------------------------------
@app.get("/api/meta")
def get_meta():
    """Старый формат: {справочник: {код: название}} для справочников со значениями-кодами."""
    dicts = load_dicts()
    meta = {name: {i["id"]: i["label"] for i in dicts[name]}
            for name, schema in DICT_SCHEMA.items() if schema["kind"] == "choice"}
    meta["storage_scopes"] = STORAGE_SCOPES
    meta["copy_stages"] = COPY_STAGES
    return jsonify(meta)


@app.get("/api/data")
def get_data():
    return jsonify(store.load())


# --- справочники ---------------------------------------------------------------
def dicts_payload(dicts: dict | None = None) -> dict:
    return {"schema": DICT_SCHEMA, "dicts": dicts or load_dicts(),
            "storage_scopes": STORAGE_SCOPES, "copy_stages": COPY_STAGES}


@app.get("/api/dicts")
def get_dicts():
    return jsonify(dicts_payload())


@app.put("/api/dicts/<name>")
def update_dict(name):
    schema = DICT_SCHEMA.get(name)
    if not schema:
        raise ApiError("Справочник не найден", 404)
    items = body().get("items")
    if not isinstance(items, list):
        raise ApiError("Список значений должен быть массивом")
    with dict_store.transaction() as stored:
        current = merge_dicts(stored)
        if schema["kind"] == "list":
            cleaned = clean_list_items(items)
        else:
            cleaned = clean_choice_items(items, schema)
            kept = {i["id"] for i in cleaned}
            data = store.load()
            for old in current[name]:
                if old["id"] in kept:
                    continue
                used = dict_usages(data, name, old["id"])
                if used:
                    shown = "; ".join(used[:5]) + (f"; …и ещё {len(used) - 5}" if len(used) > 5 else "")
                    raise ApiError(f"Нельзя удалить «{old['label']}»: значение используется — {shown}",
                                   409, usages=used)
        stored[name] = cleaned
        current[name] = cleaned
    return jsonify({"ok": True, **dicts_payload(current)})


# --- организации -------------------------------------------------------------
@app.post("/api/orgs")
def create_org():
    fields = clean_org(body())
    with store.transaction() as data:
        check_tag_unique(data, fields["tag"])
        org = {"id": new_id("org"), **fields, "devices": []}
        data["organizations"].append(org)
    return ok(data, id=org["id"])


@app.put("/api/orgs/<org_id>")
def update_org(org_id):
    fields = clean_org(body())
    with store.transaction() as data:
        org = find_org(data, org_id)
        check_tag_unique(data, fields["tag"], own_id=org_id)
        org.update(fields)
    return ok(data, id=org_id)


@app.delete("/api/orgs/<org_id>")
def delete_org(org_id):
    with store.transaction() as data:
        org = find_org(data, org_id)
        data["organizations"].remove(org)
        for st in data["storages"]:
            if org_id in st.get("org_ids", []):
                st["org_ids"].remove(org_id)
    return ok(data)


# --- устройства --------------------------------------------------------------
def clean_device(payload: dict) -> dict:
    fields = clean_fields(payload, DEVICE_FIELDS)
    check_choice(fields["kind"], "device_kinds", "Тип устройства")
    return fields


@app.post("/api/orgs/<org_id>/devices")
def create_device(org_id):
    fields = clean_device(body())
    with store.transaction() as data:
        org = find_org(data, org_id)
        dev = {"id": new_id("dev"), **fields, "sets": []}
        org.setdefault("devices", []).append(dev)
    return ok(data, id=dev["id"])


@app.put("/api/devices/<device_id>")
def update_device(device_id):
    fields = clean_device(body())
    with store.transaction() as data:
        _, dev = find_device(data, device_id)
        dev.update(fields)
    return ok(data, id=device_id)


@app.delete("/api/devices/<device_id>")
def delete_device(device_id):
    with store.transaction() as data:
        org, dev = find_device(data, device_id)
        org["devices"].remove(dev)
    return ok(data)


# --- наборы ------------------------------------------------------------------
def clean_set(data: dict, org: dict, payload: dict) -> dict:
    fields = clean_fields(payload, SET_FIELDS)
    check_choice(fields["type"], "set_types", "Тип набора")
    fields["copies"] = clean_copies(data, org, payload.get("copies"))
    return fields


@app.post("/api/devices/<device_id>/sets")
def create_set(device_id):
    payload = body()
    with store.transaction() as data:
        org, dev = find_device(data, device_id)
        bset = {"id": new_id("set"), **clean_set(data, org, payload)}
        dev.setdefault("sets", []).append(bset)
    return ok(data, id=bset["id"])


@app.put("/api/sets/<set_id>")
def update_set(set_id):
    payload = body()
    with store.transaction() as data:
        org, _, bset = find_set(data, set_id)
        bset.update(clean_set(data, org, payload))
    return ok(data, id=set_id)


@app.delete("/api/sets/<set_id>")
def delete_set(set_id):
    with store.transaction() as data:
        _, dev, bset = find_set(data, set_id)
        dev["sets"].remove(bset)
    return ok(data)


# --- хранилища ---------------------------------------------------------------
def clean_storage(payload: dict) -> dict:
    fields = clean_fields(payload, STORAGE_FIELDS)
    check_choice(fields["type"], "storage_types", "Тип хранилища")
    if fields["scope"] and fields["scope"] not in STORAGE_SCOPES:
        raise ApiError(f"Недопустимое значение «{fields['scope']}» для поля «Размещение»")
    return fields


def clean_org_ids(data: dict, raw) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ApiError("Список организаций должен быть массивом")
    known = {o["id"] for o in data["organizations"]}
    result = []
    for oid in raw:
        oid = str(oid)
        if oid not in known:
            raise ApiError("Указана несуществующая организация")
        if oid not in result:
            result.append(oid)
    return result


@app.post("/api/storages")
def create_storage():
    payload = body()
    fields = clean_storage(payload)
    with store.transaction() as data:
        org_ids = clean_org_ids(data, payload.get("org_ids"))
        st = {"id": new_id("st"), **fields, "org_ids": org_ids}
        data["storages"].append(st)
    return ok(data, id=st["id"])


@app.put("/api/storages/<storage_id>")
def update_storage(storage_id):
    payload = body()
    fields = clean_storage(payload)
    with store.transaction() as data:
        st = find_storage(data, storage_id)
        org_ids = clean_org_ids(data, payload.get("org_ids", st.get("org_ids", [])))
        removed = [oid for oid in st.get("org_ids", []) if oid not in org_ids]
        blocked = [u for oid in removed for u in storage_usages(data, storage_id, oid)]
        if blocked:
            raise ApiError("Нельзя снять доступ: хранилище используется в копиях — "
                           + describe_usages(blocked), 409, usages=blocked)
        st.update(fields)
        st["org_ids"] = org_ids
    return ok(data, id=storage_id)


@app.delete("/api/storages/<storage_id>")
def delete_storage(storage_id):
    with store.transaction() as data:
        st = find_storage(data, storage_id)
        usages = storage_usages(data, storage_id)
        if usages:
            raise ApiError("Нельзя удалить: хранилище используется в копиях — "
                           + describe_usages(usages), 409, usages=usages)
        data["storages"].remove(st)
    return ok(data)


@app.post("/api/orgs/<org_id>/storages")
def create_storage_for_org(org_id):
    """Создать хранилище из карточки организации — доступ сразу у этой организации."""
    fields = clean_storage(body())
    with store.transaction() as data:
        find_org(data, org_id)
        st = {"id": new_id("st"), **fields, "org_ids": [org_id]}
        data["storages"].append(st)
    return ok(data, id=st["id"])


@app.put("/api/orgs/<org_id>/storages/<storage_id>")
def attach_storage(org_id, storage_id):
    with store.transaction() as data:
        find_org(data, org_id)
        st = find_storage(data, storage_id)
        st.setdefault("org_ids", [])
        if org_id not in st["org_ids"]:
            st["org_ids"].append(org_id)
    return ok(data, id=storage_id)


@app.delete("/api/orgs/<org_id>/storages/<storage_id>")
def detach_storage(org_id, storage_id):
    with store.transaction() as data:
        find_org(data, org_id)
        st = find_storage(data, storage_id)
        usages = storage_usages(data, storage_id, org_id)
        if usages:
            raise ApiError("Нельзя отключить: хранилище используется в копиях — "
                           + describe_usages(usages), 409, usages=usages)
        if org_id in st.get("org_ids", []):
            st["org_ids"].remove(org_id)
    return ok(data, id=storage_id)


# --- запуск ------------------------------------------------------------------
def ensure_data_file() -> None:
    """При первом запуске создать data.json (с демо-данными, если они есть)."""
    if DATA_FILE.exists():
        return
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    if DEMO_FILE.exists():
        shutil.copyfile(DEMO_FILE, DATA_FILE)
    else:
        store.save(json.loads(json.dumps({"version": 1, "storages": [], "organizations": []})))


if __name__ == "__main__":
    ensure_data_file()
    print(f"План резервного копирования: http://{HOST}:{PORT}  (данные: {DATA_FILE})")
    app.run(host=HOST, port=PORT, debug=False)
