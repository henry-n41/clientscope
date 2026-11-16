# Agent cards (copies)

Byte-for-byte copies of the cards served from the `agent-cards` branch of this repo
(https://raw.githubusercontent.com/henry-n41/clientscope/agent-cards/...). Their SHA-256 is pinned on chain in the
CIS-8004 Agent Registry, so never edit them by hand.

- `agent-card.json`: ClientScope Work Agent, agent #1010 (v1.1.0, "Strapnode"). Pinned once the owner approves it with `approve-agent-1010.html`.
- `../client-agent-card/client-agent-card.json`: Northgate Supplies Buyer Agent (demo), agent #1211.
- `approve-agent-1010.html`: the owner's one-time approval page (updateOperator for ClientScope's operating key, then setAgentURI for the fixed card).
  Both payloads were dry-run as the owner account against the live contract before the page was made.
