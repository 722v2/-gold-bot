@echo off
title MT5 Execution Bridge Server for Gold Scalper
echo =======================================================
echo Starting MT5 REST Bridge Server...
echo =======================================================

:: 1. Check Python installation
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3.10+ from python.org and check 'Add Python to PATH'.
    pause
    exit /b
)

:: 2. Install required packages
echo Installing / Verifying requirements (MetaTrader5, Flask, flask-cors)...
pip install -r mt5_requirements.txt

:: 3. Configure environment variables (You can edit these)
set PORT=5001
set MT5_API_KEY=gold_ai_secret_key_2026
set MT5_ACCOUNT=
set MT5_PASSWORD=
set MT5_SERVER=
set MT5_ACCOUNT_TYPE=DEMO

echo.
echo =======================================================
echo MT5 Bridge is launching on port %PORT%...
echo Press Ctrl+C to stop.
echo =======================================================
echo.

python mt5_bridge_server.py
pause
