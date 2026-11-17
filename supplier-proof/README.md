# Northgate Supplies domain proof (for the supplier demo site)

`.well-known/concordium-agent.json` is the file the real supplier site publishes so ClientScope can check that
the website, its Concordium account (`4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH`) and its badge
(CIS-8004 agent #1211, `JyP9XR6EkrzHnx9g177u9`) all point to each other. It is signed with that account's key
(Concordium signMessage). It holds no secret.

It must be published at:
https://henry-n41.github.io/clientscope-supplier-demo/.well-known/concordium-agent.json

GitHub Pages runs Jekyll, which hides folders that start with a dot, so the repo also needs an empty `.nojekyll`
file at its root.

## Publish it (GitHub website, about 2 minutes)

1. Open https://github.com/henry-n41/clientscope-supplier-demo
2. Click **Add file**, then **Create new file**. Name it `.nojekyll`. Leave it empty (type one space if GitHub
   will not save an empty file). Click **Commit changes...**, keep "Commit directly to the main branch", and click
   **Commit changes**.
3. Click **Add file**, then **Create new file** again. In the name box type `.well-known/concordium-agent.json`
   (typing the `/` makes the folder).
4. Open https://raw.githubusercontent.com/henry-n41/clientscope/main/supplier-proof/.well-known/concordium-agent.json,
   select all, copy, and paste it into the editor. Click **Commit changes...**, then **Commit changes**.
5. Wait one to two minutes, then open
   https://henry-n41.github.io/clientscope-supplier-demo/.well-known/concordium-agent.json. It should show the JSON.

Then press "Check both sites now" in the dashboard's Domain proof job: the real supplier turns green.

Check from the command line: `node x402/domain_proof.mjs verify https://henry-n41.github.io/clientscope-supplier-demo/`
