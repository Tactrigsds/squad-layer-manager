---
audience: operators
kind: fixed
---

SLM no longer stops managing a server after its RCON connection drops mid-response.

When an RCON connection dropped partway through a response, SLM could misread the first response after reconnecting and stop
managing the server. The server's pages then failed to load until the server was disabled and enabled again, or SLM was
restarted. SLM now discards the partial response. If SLM does stop managing a server after repeated connection
failures, SLM starts managing it again after 30 seconds.

A server agent that stops answering is dropped within 30 seconds, so the agent can reconnect straight away. Before,
SLM held the dead connection for several minutes and refused each reconnect as a duplicate agent.
