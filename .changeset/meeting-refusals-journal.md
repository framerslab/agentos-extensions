---
"@framers/agentos-ext-meeting-browser": patch
---

Distinguish permission refusals from exhausted capacity using the existing dispatch refusal contract: a paused scheduler and a Google Meet identity pool with no signed-in identity (the scheduler's new `no signed-in identity` answer) are `permission_denied` refusals, while full slots and a pool whose signed-in identities are all held by live runs, or that cannot be read, stay `NoCapacityError`. Report malformed channel messages once per leased run with the run's id and a fixed type word, and support an optional journald policy for new bot containers. Unset logging configuration retains the Docker daemon's default. Require the published AgentOS refusal contract available in 0.15.9 or later.
