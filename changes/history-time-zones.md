---
audience: users
kind: added
---

History can show times in UTC, in a server's time zone, or in any IANA time zone.

Pick one in the new _Time zone_ field. The _From_ and _To_ bounds are entered in the same zone, and saved queries and
shared links keep it. The default is still the browser's time zone, and event times now follow it. Before this change
they used the SLM host's time zone, while their tooltips used the browser's.

Two new settings set time zones. `timeZone`, per server, is UTC by default. `defaultTimeZone`, global, sets the zone of
history links quoted into Discord and of history results a script fetches as text or CSV, when the link or query sets
none.
By default it is the time zone of the server the events are from. The Discord reply now names the number of events and
their time zone.
