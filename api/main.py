"""YCQ API.

    uvicorn api.main:app --reload        # from the repo root; docs at /docs

One router per feature in api/routers/. Add yours to the list for who may
use it: PUBLIC (no login), ANY_ROLE (analysts and admins) or ADMIN_ONLY.
tests/test_auth.py checks every route against these lists.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import auth
from .db import mongo_client, pg_pool
from .routers import admin, dashboard, flows, health, plans, saved_views, users, zones
from .routers import auth as auth_routes

PUBLIC = [health.router, auth_routes.router]   # /auth/me checks the token itself
ANY_ROLE = [zones.router, dashboard.router, flows.router, plans.router, saved_views.router]
ADMIN_ONLY = [admin.router, users.router]

# Shows the api's own log lines (such as each user-deletion step) next to uvicorn's.
logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    auth.jwt_secret()   # refuse to start without a strong secret
    pg_pool.open(wait=True, timeout=60)
    yield
    pg_pool.close()
    mongo_client.close()


app = FastAPI(title="Yellow Cab Query API", lifespan=lifespan)
# The React dev server (npm run dev) runs on another port.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"],
                   allow_methods=["*"], allow_headers=["*"])

for router in PUBLIC:
    app.include_router(router)
for router in ANY_ROLE:
    app.include_router(router, dependencies=[Depends(auth.any_role)])
for router in ADMIN_ONLY:
    app.include_router(router, dependencies=[Depends(auth.admin_only)])
