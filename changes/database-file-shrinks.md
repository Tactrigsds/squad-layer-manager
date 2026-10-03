---
audience: operators
kind: changed
---

The database file now shrinks on its own as old data is removed, instead of keeping the freed space for good.

The first start after upgrading compacts the database once, before SLM begins serving. A 2.5 GB production database, three quarters of it free space, took 3 seconds and came out at 545 MB. Compacting needs free disk space about the size of the compacted database while it runs. With `DB_AUTOMIGRATE` off, `pnpm db:migrate` does the compacting instead.
