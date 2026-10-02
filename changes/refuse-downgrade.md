---
audience: operators
kind: added
---

SLM refuses to start on a database a newer build has migrated, instead of running against a schema it does not know.

The log names the migrations the running build is missing and the image tag of the build that last ran against the
database. To go back to an older build, restore a backup taken before the upgrade, as _Downgrading_ in the install
guide describes.
