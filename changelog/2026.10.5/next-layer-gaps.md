---
audience: users
kind: fixed
---

SLM no longer misses a next layer set in the seconds after a match starts.

An admin could set a next layer while the new match was loading, or while SLM was reconnecting to the server. SLM then neither added that layer to the queue nor overrode it. SLM now handles that change like any other.

When the connection to the server dropped as SLM was setting the next layer, the server kept its old next layer. SLM now sets the first item in the queue once the connection is back.

The match history showed `(???)` as the length of a match that lasted under a minute. It now shows `1m`.
