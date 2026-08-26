"""Give ``qiraa`` an auto-incrementing integer primary key.

The table was created with a UUID pk in 0001. No backend can convert a uuid
column into a serial in place — Django's ``AlterField`` would emit
``ALTER COLUMN id TYPE bigint USING id::bigint``, and uuid does not cast to
bigint — so the table is rebuilt instead.

The rebuild DDL is backend-specific, hence the dispatch below. Originally this
migration carried only the SQLite form (``INTEGER PRIMARY KEY AUTOINCREMENT``),
which is a syntax error on PostgreSQL and blocked the move off SQLite.

Dropping the table is safe here: ``SuraAyaCount.qiraa`` was removed in 0003 and
``Mushaf.qiraa`` in 0005 (it returns in 0007), so nothing references ``qiraa``
at this point in the history.
"""

from django.db import migrations, models

# SQLite. Unchanged from the original migration — existing databases have
# already applied exactly this.
SQLITE_STATEMENTS = [
    """
    CREATE TABLE "qiraa_temp" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "name" varchar(256) NOT NULL UNIQUE,
        "name_arabic" varchar(256) NOT NULL UNIQUE,
        "description" text NOT NULL,
        "counting_system_id" integer NULL
            REFERENCES "api_countingsystem" ("id") ON DELETE CASCADE
    )
    """,
    """
    INSERT INTO "qiraa_temp" ("name", "name_arabic", "description", "counting_system_id")
    SELECT "name", "name_arabic", "description", "counting_system_id" FROM "qiraa"
    """,
    'DROP TABLE "qiraa"',
    'ALTER TABLE "qiraa_temp" RENAME TO "qiraa"',
]

# PostgreSQL. Differences that matter versus the SQLite form:
#   * ``bigserial`` rather than INTEGER AUTOINCREMENT;
#   * ``counting_system_id`` must be ``bigint`` — CountingSystem.id is a
#     BigAutoField, and Postgres requires an FK column to match the type it
#     references, where SQLite does not;
#   * ``DEFERRABLE INITIALLY DEFERRED``, which is how Django writes its own FKs.
#     loaddata depends on it: fixtures are loaded in alphabetical model order, so
#     activityevent rows arrive before the mushaf rows they point at, and only a
#     deferrable constraint survives that.
POSTGRES_STATEMENTS = [
    """
    CREATE TABLE "qiraa_temp" (
        "id" bigserial NOT NULL PRIMARY KEY,
        "name" varchar(256) NOT NULL UNIQUE,
        "name_arabic" varchar(256) NOT NULL UNIQUE,
        "description" text NOT NULL,
        "counting_system_id" bigint NULL
            REFERENCES "api_countingsystem" ("id") DEFERRABLE INITIALLY DEFERRED
    )
    """,
    """
    INSERT INTO "qiraa_temp" ("name", "name_arabic", "description", "counting_system_id")
    SELECT "name", "name_arabic", "description", "counting_system_id" FROM "qiraa"
    """,
    'DROP TABLE "qiraa"',
    'ALTER TABLE "qiraa_temp" RENAME TO "qiraa"',
    # Postgres does not index a foreign key automatically; Django would.
    'CREATE INDEX "qiraa_counting_system_id_idx" ON "qiraa" ("counting_system_id")',
]


def rebuild_qiraa(apps, schema_editor):
    statements = (
        SQLITE_STATEMENTS if schema_editor.connection.vendor == "sqlite" else POSTGRES_STATEMENTS
    )
    for statement in statements:
        schema_editor.execute(statement)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0005_remove_mushaf_qiraa_remove_qiraa_created_at_and_more"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(rebuild_qiraa, migrations.RunPython.noop),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="qiraa",
                    name="id",
                    field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID"),
                    preserve_default=False,
                ),
            ],
        ),
    ]
