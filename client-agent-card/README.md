# Buyer agent: Northgate Supplies Buyer Agent (demo), CIS-8004 agent #1211

Registered on Concordium testnet on 16 Nov 2026 from the buyer account `4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH`.

| What | Value |
|------|-------|
| Token address (badge) | `JyP9XR6EkrzHnx9g177u9` |
| Registry | CIS-8004, contract 12802,0 (testnet) |
| Agent Card | https://raw.githubusercontent.com/henry-n41/clientscope/agent-cards/client-agent-card.json |
| Card SHA-256 (pinned on chain) | `19f65f46d5f4b324d19f93997e049b259a22cccf245133fb28a2fe1697ad5497` |
| register tx | [41d04e48…](https://ccdexplorer.io/testnet/transaction/41d04e48f43f118d452a39fe3be25faae8eadc86a239b18eb33a46d4e1c9912e) |
| setAgentURI tx (pins the card hash) | [3a7f1803…](https://ccdexplorer.io/testnet/transaction/3a7f1803d399a8f79b0bc0e41a5b423eb247cdf4fa1a98c43a23ccc51f74d39b) |
| Badge check | https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9XR6EkrzHnx9g177u9?network=testnet |

`client-agent-card.json` here is a byte-for-byte copy of the hosted card. Never edit either by hand: any change breaks the
on-chain hash. To change the card, regenerate it (Agent Registry `build_agent_badge`), push it to the `agent-cards` branch,
then pin the new hash with `node x402/registry.mjs send CCD_CLIENT_PRIVATE_KEY <buyer account>` and a `build_set_agent_uri` payload.

ClientScope refuses any buyer agent that is not registered, not Active, whose card does not hash to the on-chain value, or
whose signing key does not control the agent it claims (see `x402/agent_trust.mjs` and `x402/buyer_check.mjs`).
