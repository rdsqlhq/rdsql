# Backup / restore / migrate end-to-end tests

Runs the real Backup, Restore and Migrate Database screens against real
database servers and checks that every copy matches its source row for row.

```sh
make e2e-backup        # default stack + SQLite/DuckDB files
make e2e-backup-all    # the above, then CockroachDB, YugabyteDB, TiDB, SQL Server
make e2e-backup-down   # stop everything and delete the data

e2e/backup/run-all.sh cockroach mssql   # only some of the extra engines
```

The first `up` seeds the default source servers, which takes a few minutes
(MySQL is the slowest). Later runs reuse the seeded data.

## What runs

**Backup** (`backup.e2e.test.tsx`, `engines.e2e.test.tsx`): for each engine,
a backup straight into another connection, and a backup to a `.sql` file that
is then restored through the Restore screen.

| Engine | Where | Source → target | Size |
| --- | --- | --- | --- |
| PostgreSQL | default stack | 16 (`:55432`) → 17 (`:55433`) | ~467k rows, 65 MB |
| MySQL 8.4 | default stack | `:53306` → `:53307` | ~450k rows, 45 MB |
| MariaDB 11.4 | default stack | `:53308` → `:53309` | ~450k rows |
| SQLite | local file | file → file | ~110k rows |
| DuckDB | local file | file → file | ~110k rows |
| CockroachDB 24.3 | profile `cockroach` (`:56257`) | database → database | ~110k rows |
| YugabyteDB 2024.2 | profile `yugabyte` (`:55434`) | database → database | ~110k rows |
| TiDB 8.5 | profile `tidb` (`:54000`) | database → database | ~450k rows |
| SQL Server (azure-sql-edge) | profile `mssql` (`:51433`) | database → database | ~110k rows |

Postgres also tests a backup into a schema that doesn't exist yet (Safe mode).

With `E2E_NEON_URL` set to a Neon connection string, `neon.e2e.test.tsx`
also backs up from the local Postgres source into Neon, and restores both an
rdSQL backup and a default `pg_dump` (owners and grants kept) into it. It
works in a scratch database it creates and drops.

**Restoring other tools' dumps** (`dumps.e2e.test.tsx`): a `pg_dump` script
(made by pg_dump 17 from the 16 source, so it includes `\restrict` lines and
`COPY` blocks), plus `mysqldump` and `mariadb-dump` scripts made with
`--databases`, `--routines` and `--triggers`, restored through the Restore
screen into an empty database and compared row for row. Also checks that
ownership and grants for missing roles are skipped.

**Data grid types** (`grid-types.e2e.test.tsx`): Postgres types the driver
only gets in binary (interval, inet, cidr, macaddr, bit, varbit, timetz,
money, arrays of them) read the way Postgres displays them, on all 10,000
type-zoo rows.

**Compare & Sync** (`compare.e2e.test.tsx`): the setup card, a schema
compare, the result, and "New compare".

**Migrate** (`migrate.e2e.test.tsx`): the Migrate Database wizard for
MySQL → Postgres, Postgres → MySQL, and (when the `mssql` profile is up)
SQL Server → Postgres and SQL Server → MySQL. Checks row counts per table and
that unicode text survives.

The sources are e-commerce shaped (customers, orders, order items, an audit
log with no primary key) plus a type-zoo table with each engine's awkward
types: enums, jsonb scalars, bytea/blob/varbinary, bit, interval, inet,
money, datetimeoffset, arrays, integers above 2^53, quotes, backslashes,
emoji. See `seed/`.

After each backup the test compares a per-table fingerprint (row count plus a
hash of every row) of source and copy. On Postgres, MySQL and MariaDB it then
inserts a row into the copy to check that defaults, AUTO_INCREMENT /
serial / identity sequences and enum types came across, and that views were
not copied.

## Memory

Docker Desktop's default VM has 4 GB. The default stack uses about 2 GB, so
the extra engines each get their own compose profile and `run-all.sh` starts
them one at a time. CockroachDB, YugabyteDB, TiDB and SQL Server run as a
single server each; the test seeds `rdsql_src` on it and copies into a second
database on the same server.

## How it works

`setup.ts` points the screens' Tauri calls at `bridge.ts`, which starts
`src-tauri/src/commands/e2e_bridge.rs` (an ignored cargo test) and talks to it
over stdin/stdout. So the frontend code and the Rust drivers are the real
ones. Only the native file dialogs and the file system are stubbed: dialogs
return the path the test chose, and files are read and written with Node.
Seeding goes through the same bridge, so engines without init-script support
(TiDB, YugabyteDB, SQL Server) need nothing extra.

Ports are off the defaults so this stack can run next to a local Postgres or
MySQL. The passwords in `docker-compose.yml` are dev-only.
