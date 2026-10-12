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
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from core.config import settings
from models.database import verify_schema, get_db
from routers import auth, profile, challenges, matches, stats, rematch
from routers.expiry import start_expiry_task, stop_expiry_task
from ws.routes import router as ws_router

_BACKEND_DIR  = os.path.dirname(__file__)
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
FRONTEND_DIR  = os.path.join(_PROJECT_ROOT, "frontend")
log = logging.getLogger("arrowmatch.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.validate_for_startup()
    os.makedirs(FRONTEND_DIR, exist_ok=True)
    verify_schema()
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


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response

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
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        log.error("Health check failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {"status": "ok", "version": settings.VERSION}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error("Unhandled request error method=%s path=%s type=%s", request.method, request.url.path, type(exc).__name__)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
