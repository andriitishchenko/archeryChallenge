"""
ArrowMatch API — FastAPI application entry point.

Directory layout (frontend moved out of backend):
  project-root/
    backend/     ← this file lives here
    frontend/    ← SPA assets (index.html, css/, js/)

Run with:
    cd backend
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

UI:       http://localhost:8000/
API docs: http://localhost:8000/docs   (DEBUG mode only)
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from core.config import settings
from models.database import create_tables
from routers import auth, profile, challenges, scores
from ws.routes import router as ws_router

# Frontend lives one level above the backend package
_BACKEND_DIR  = os.path.dirname(__file__)
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
FRONTEND_DIR  = os.path.join(_PROJECT_ROOT, "frontend")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    description="Archery Challenge Platform API — real-time matchmaking, scoring, and leaderboards.",
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
)

# ── Middleware ────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ────────────────────────────────────────────────────────────────────

app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(challenges.router)
app.include_router(scores.router)
app.include_router(ws_router)

# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
def on_startup():
    create_tables()
    os.makedirs(FRONTEND_DIR, exist_ok=True)


# ── Frontend serving ──────────────────────────────────────────────────────────

# Serve /static/* → frontend/ (CSS, JS, images).
# HTML still references /static/css/ and /static/js/ so asset paths stay intact.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def serve_index():
    """Serve the frontend SPA on GET /."""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.isfile(index_path):
        return JSONResponse(
            status_code=404,
            content={"detail": "Frontend not found. Place index.html in ../frontend/"},
        )
    return FileResponse(index_path, media_type="text/html")


# ── Health check ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "version": settings.VERSION}


# ── Global error handler ──────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    # In production: log to your observability stack
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )
