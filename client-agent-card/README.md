# Client agent CIS-8004 registration (option a): prepared, not sent

ClientScope already checks the buyer by a signed challenge and on-chain identity facts (see ../x402/README.md, Feature 3).
Registering the buyer agent in the same CIS-8004 registry (contract 12802) would add one more check:
"this account owns an active registered agent whose card hash matches".

Files:
- `client-agent-card.json`: the buyer agent's card. sha256 is in `register-client-agent.json`.
- `register-client-agent.json`: the exact `CIS-8004.register` call (parameter JSON), prepared and not sent.

What Henry would need to do:
1. Add `client-agent-card.json` unchanged to the GitHub Pages repo `clientscope-supplier-demo` and push, so it is served at
   https://henry-n41.github.io/clientscope-supplier-demo/client-agent-card.json (any edit changes the hash; re-run the prep then).
2. Send the `register` call from the buyer account 4j6RhVCW... The buyer key is already in env, so this can be sent
   headless with no wallet (gas paid in CCD by the buyer account, a few CCD, estimated at send time, not by the sponsor). Alternatively sign it in
   the Concordium Browser Wallet with a page like `supplier-page/sign-uri.html`, if that account is imported there.
3. Then ClientScope adds the rule `registered_agent` to its accepted-buyer policy (look up the token via the registry's
   `agentOf` or owner view and compare the hosted card hash).

Nothing here touches ClientScope's own agent-card.json or its badge.
