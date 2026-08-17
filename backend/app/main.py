"""FastAPI application entrypoint.

    uvicorn app.main:app --reload
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import OperationalError

from .api.v1 import router as v1_router
from .config import get_settings
from .ratelimit import limiter

settings = get_settings()
logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="SponsorScope API",
    version="0.1.0",
    description=(
        "Public, unauthenticated lookup of visa sponsorship history from government "
        "open data. Stores no user data of any kind. MIT licensed."
    ),
    license_info={"name": "MIT", "url": "https://opensource.org/licenses/MIT"},
)

app.state.limiter = limiter

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$|^moz-extension://.*$",
    allow_methods=["GET"],
    allow_headers=["content-type"],
    # No credentials, ever. There is nothing to send: the API sets no cookie and
    # reads no header that could identify a caller.
    allow_credentials=False,
)


@app.exception_handler(RateLimitExceeded)
def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Explains the limit rather than returning a bare 429.

    Anyone hitting this is either abusing the endpoint or self-hosting badly; the
    second group deserves a pointer to the fix.
    """
    return JSONResponse(
        status_code=429,
        content={
            "error": "rate_limited",
            "detail": (
                "This public API is rate limited per IP. If you need higher volume, "
                "self-host: the data and the pipelines are MIT licensed and the ETL "
                "scripts are in the repository."
            ),
            "limit": str(exc.detail),
        },
        headers={"Retry-After": "60"},
    )


@app.exception_handler(OperationalError)
def database_unavailable_handler(request: Request, exc: OperationalError) -> JSONResponse:
    """Turns a database outage into an honest 503.

    Unlike Redis, Postgres is a hard dependency for a lookup — there is nothing
    sensible to serve without it. What matters is that the client can tell
    "the service is down" apart from "we have no record of this company", since
    the extension renders those two very differently and must never show the
    reassuring-looking one when it actually means the former.
    """
    logger.error("database unavailable", exc_info=exc)
    return JSONResponse(
        status_code=503,
        content={
            "error": "database_unavailable",
            "detail": "The lookup database is unavailable. This is not a result about any company.",
        },
        headers={"Retry-After": "30"},
    )


app.include_router(v1_router)


@app.get("/")
def root() -> dict:
    return {
        "name": "SponsorScope API",
        "docs": "/docs",
        "source": "https://github.com/your-org/sponsorscope",
        "privacy": "This API stores no personal data. See docs/privacy.md in the repository.",
    }
