"""YCQ API.

    uvicorn api.main:app --reload        # from the repo root; docs at /docs

One router per feature in api/routers/. Add yours to ROUTERS.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import auth
from .db import mongo_client, pg_pool
from .routers import admin, dashboard, flows, health, plans, saved_views, zones

ROUTERS = [health.router, zones.router, dashboard.router, flows.router,
           plans.router, saved_views.router, admin.router]


@asynccontextmanager
async def lifespan(app: FastAPI):
    pg_pool.open(wait=True, timeout=60)
    with pg_pool.connection() as conn:
        auth.ensure_dev_user(conn)
    yield
    pg_pool.close()
    mongo_client.close()


app = FastAPI(title="Yellow Cab Query API", lifespan=lifespan)
# The React dev server (npm run dev) runs on another port.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"],
                   allow_methods=["*"], allow_headers=["*"])

for router in ROUTERS:
    app.include_router(router)
