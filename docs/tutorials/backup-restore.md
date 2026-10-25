# Backup & Restore

## Purpose

Copy a database's tables and rows to a `.sql` file, to S3-compatible storage,
or straight into another connection, and run a `.sql` script back into a
database. Restore also takes scripts made by `pg_dump` and `mysqldump` /
`mariadb-dump`.

## Requirements

- A saved connection to the database to back up or restore into
- For **DB Connection** backups: a second connection of the same engine
  (PostgreSQL and Neon count as one)

## Back up

1. In the sidebar, right-click a connection (or one of its databases/schemas)
   and choose **Backup...**.
2. Pick the tables, and for each whether to copy its structure, its data, or
   both.
3. Choose where it goes:
   - **File**: a `.sql` script.
   - **DB Connection**: pick the target connection, then its schema
     (PostgreSQL) or database (MySQL family). For PostgreSQL a schema that
     doesn't exist yet is created.
   - **S3 Storage**: a storage connection and path, optionally gzip-compressed.
4. Choose how to treat tables that already exist on the target: insert only,
   truncate first, or drop and recreate.
5. Click **Start Backup**. If something fails, the run pauses; fix the cause
   and click **Resume** to continue from the same row.

A copy keeps tables, every row, primary keys, column defaults, auto-increment /
serial / identity counters (moved past the copied ids) and PostgreSQL enum
types. Views, other indexes, unique constraints and foreign keys are not
copied.

## Restore

1. Right-click the connection (or database/schema) to restore into and choose
   **Restore...**.
2. Click **Choose a .sql file...**, or **From Storage...** for a file in S3. The
   modal shows what kind of script it is (rdSQL backup, pg_dump script,
   mysqldump script or SQL script) and its size.
3. Check the options:
   - **Stop on first error** (on by default): pause at a failing statement so
     you can fix the cause and **Resume** from it.
   - **Ignore database name baked into the file** (on by default): run every
     statement in this connection's database, whatever the file names, and
     skip its `USE` statements. Not used for `pg_dump` scripts.
   - **Skip ownership and privileges** (on by default): leave out `OWNER TO`,
     `GRANT` and `REVOKE`, which name users from the server the dump came
     from.
4. Click **Run Restore**.

The file is read a few megabytes at a time, so its size doesn't matter, and
statements run in the file's own order on one connection, as `psql` or
`mysql` would run them. `COPY ... FROM stdin` data in a `pg_dump` script is
loaded with COPY.

## Expected result

The footer shows **Done**, and the log ends with the number of statements run
and rows copied, plus anything skipped. The full log is also saved to a file;
its path is shown above the log.

## Troubleshooting

- **`session_replication_role` / permission denied** — switching foreign-key
  checks off needs superuser, which managed PostgreSQL (Neon, RDS, Supabase)
  doesn't grant. The restore notes it and continues; tables are created
  parents-first so the data still loads.
- **"column … does not exist" on insert** — the target already has a table
  with that name but different columns. Back up again with **Drop &
  recreate**, or restore into an empty database.
- **"role … does not exist"** — leave **Skip ownership and privileges** on.
