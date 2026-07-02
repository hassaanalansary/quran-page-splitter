from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0005_remove_mushaf_qiraa_remove_qiraa_created_at_and_more"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql="""
                        CREATE TABLE "qiraa_temp" (
                            "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                            "name" varchar(256) NOT NULL UNIQUE,
                            "name_arabic" varchar(256) NOT NULL UNIQUE,
                            "description" text NOT NULL,
                            "counting_system_id" integer NULL
                                REFERENCES "api_countingsystem" ("id") ON DELETE CASCADE
                        );
                        INSERT INTO "qiraa_temp" ("name", "name_arabic", "description", "counting_system_id")
                        SELECT "name", "name_arabic", "description", "counting_system_id" FROM "qiraa";
                        DROP TABLE "qiraa";
                        ALTER TABLE "qiraa_temp" RENAME TO "qiraa";
                    """,
                    reverse_sql=migrations.RunSQL.noop,
                ),
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
