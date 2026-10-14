"""Run the Ears sidecar: python run.py"""
import uvicorn

from ears.main import PORT

if __name__ == "__main__":
    uvicorn.run("ears.main:app", host="127.0.0.1", port=PORT, log_level="warning")
