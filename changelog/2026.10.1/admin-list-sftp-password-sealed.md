---
audience: operators
kind: changed
---

The password of an SFTP admin list source is now treated as a credential. SLM encrypts the password in the database,
and hides it on the settings page and in the audit log.

The first start after upgrading encrypts a stored password in place. A version older than this one reads the encrypted
value as the password, so downgrading needs the password entered again.
