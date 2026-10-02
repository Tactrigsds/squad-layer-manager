---
audience: operators
kind: changed
---

Backups are smaller and take less time. A backup copies only the data your database holds, without the free space a database file keeps after old data is deleted. On a 2.5 GB production database with 1.9 GB of free space, a backup shrank from 447 MB to 107 MB and took 14 seconds instead of 57.

A database restored from one of these backups is compacted the same way, so its file is smaller than the one it was taken from.

Recording game events no longer stalls SLM for 10 to 20 ms every few hundred events.
