# Start SafeView FastAPI backend (uvicorn is not required on PATH)
Set-Location $PSScriptRoot
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
