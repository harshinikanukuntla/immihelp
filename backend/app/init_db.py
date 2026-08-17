"""Creates the schema.

    python -m app.init_db

Uses SQLAlchemy metadata rather than a migration chain because the schema is
young and there is no production deployment to migrate yet. Alembic is a
dependency already; generate the first revision from this schema when the
project has real data to preserve.

The pg_trgm extension is created first: the trigram indexes in `models.py`
cannot be built without it, and the blocking query in
`resolution/repository.py` degrades to a sequential scan if the indexes are
silently skipped.
"""

from __future__ import annotations

import logging

from sqlalchemy import text

from .db import engine
from .models import Base

logger = logging.getLogger(__name__)


def init() -> None:
    with engine.begin() as connection:
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))

    Base.metadata.create_all(engine)

    with engine.begin() as connection:
        # Verify the trigram indexes actually landed. A missing index here does
        # not fail any query — it just makes every lookup a full table scan,
        # which is exactly the kind of problem that goes unnoticed until the
        # table is large.
        rows = connection.execute(
            text(
                "SELECT indexname FROM pg_indexes "
                "WHERE indexname IN "
                "('ix_companies_normalized_name_trgm', 'ix_aliases_normalized_trgm')"
            )
        ).all()
        found = {row[0] for row in rows}

    missing = {"ix_companies_normalized_name_trgm", "ix_aliases_normalized_trgm"} - found
    if missing:
        logger.warning("trigram indexes were not created: %s", ", ".join(sorted(missing)))
    else:
        logger.info("schema ready, trigram indexes present")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    init()
    print("Schema created. Next: python -m etl.run ingest uscis_h1b_hub --file ... --published ...")
