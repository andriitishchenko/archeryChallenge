"""
ArrowMatch API — FastAPI application entry point.

Run with:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

The server also serves the frontend:
  GET /          → static/index.html
  GET /static/*  → static assets
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

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

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
    # Create static dir if missing (first run)
    os.makedirs(STATIC_DIR, exist_ok=True)


# ── Frontend serving ──────────────────────────────────────────────────────────

# Serve /static/* assets (CSS, JS, images placed in ./static/)
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def serve_index():
    """Serve the frontend SPA on GET /."""
    index_path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.isfile(index_path):
        return JSONResponse(
            status_code=404,
            content={"detail": "Frontend not found. Place index.html in ./static/"},
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
