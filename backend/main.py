"""
ArrowMatch API — application entry point.

Layout:
  project-root/
    backend/   ← this file lives here
    frontend/  ← SPA assets served as /static/*

Run:
    cd backend && uvicorn main:app --host 0.0.0.0 --port 8000 --reload
UI:       http://localhost:8000/
API docs: http://localhost:8000/docs  (DEBUG=true only)
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from core.config import settings
from models.database import create_tables
from routers import auth, profile, challenges, matches, stats, rematch
from routers.expiry import start_expiry_task, stop_expiry_task
from ws.routes import router as ws_router

_BACKEND_DIR  = os.path.dirname(__file__)
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
FRONTEND_DIR  = os.path.join(_PROJECT_ROOT, "frontend")


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(FRONTEND_DIR, exist_ok=True)
    create_tables()
    start_expiry_task()
    yield
    stop_expiry_task()


app = FastAPI(
    title       = settings.APP_NAME,
    version     = settings.VERSION,
    description = "Archery Challenge Platform API — real-time matchmaking, scoring, leaderboards.",
    docs_url    = "/docs"  if settings.DEBUG else None,
    redoc_url   = "/redoc" if settings.DEBUG else None,
    lifespan    = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins     = settings.CORS_ORIGINS,
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)

# Routers
app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(challenges.router)
app.include_router(matches.router)
app.include_router(stats.router)
app.include_router(rematch.router)
app.include_router(ws_router)

# Serve frontend
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def serve_index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.isfile(index_path):
        return JSONResponse(status_code=404, content={"detail": "Frontend not found."})
    return FileResponse(index_path, media_type="text/html")


@app.get("/health")
def health():
    return {"status": "ok", "version": settings.VERSION}


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
