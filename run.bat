@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Создаю виртуальное окружение...
    python -m venv .venv || goto :error
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :error
)

start "" http://127.0.0.1:8765
".venv\Scripts\python.exe" app.py
goto :eof

:error
echo Не удалось подготовить окружение. Проверьте, что установлен Python 3.10+.
pause
