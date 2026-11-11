"""Хранение данных плана резервного копирования в JSON-файлах.

Запись атомарная (через временный файл), перед каждой записью
предыдущая версия сохраняется в папку backups/ (имя файла + отметка времени).
"""
from __future__ import annotations

import copy
import json
import os
import shutil
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

EMPTY_DATA = {"version": 1, "updated_at": None, "storages": [], "organizations": []}


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


class Store:
    def __init__(self, path: Path, backup_dir: Path, keep_backups: int = 50,
                 empty: dict | None = None, lock=None):
        self.path = Path(path)
        self.backup_dir = Path(backup_dir)
        self.keep_backups = keep_backups
        self.empty = EMPTY_DATA if empty is None else empty
        # общий замок для нескольких файлов, чтобы связанные проверки шли без гонок
        self._lock = lock or threading.RLock()

    # --- чтение / запись -------------------------------------------------
    def load(self) -> dict:
        with self._lock:
            if not self.path.exists():
                return copy.deepcopy(self.empty)
            with self.path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            for key, value in self.empty.items():
                if key not in data:
                    data[key] = copy.deepcopy(value)
            return data

    def save(self, data: dict) -> None:
        with self._lock:
            data["updated_at"] = datetime.now().isoformat(timespec="seconds")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._backup_current()
            tmp = self.path.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

    @contextmanager
    def transaction(self):
        """Загрузить данные, дать их изменить и сохранить, если не было исключения."""
        with self._lock:
            data = self.load()
            yield data
            self.save(data)

    # --- резервные копии самого файла --------------------------------------
    def _backup_current(self) -> None:
        if not self.path.exists():
            return
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        prefix = self.path.stem
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(self.path, self.backup_dir / f"{prefix}-{stamp}.json")
        backups = sorted(self.backup_dir.glob(f"{prefix}-*.json"))
        for old in backups[: max(0, len(backups) - self.keep_backups)]:
            try:
                old.unlink()
            except OSError:
                pass
