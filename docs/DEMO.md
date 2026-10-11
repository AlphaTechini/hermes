# Demo video script (3 minutes or less)

Target length: 2:50. Hard limit: 3:00 (the rules say 3 minutes or less, public, with real Monad transactions). The video must show the product working on Monad testnet, not the simulator, so record in live mode (`PERPL_MODE=live`, see [README](../README.md#live-testnet-setup)).

Voice-over is plain and short: about 380 words in total. Say the numbers that appear on screen, whatever they are. Do not promise a latency the screen does not show.

## Shot list

| Time | Screen | Voice-over | Notes |
|---|---|---|---|
| 0:00 to 0:15 | Split screen. Left: a TradingView chart with an alert firing. Right: the Perpl trading page, idle. Then a clock overlay counting seconds. | "You have a strategy on TradingView. When the alert fires, you still have to open Perpl and place the trade yourself. Asleep, busy or late, you miss it or you get a worse price. And you never learn how far the live result drifted from the chart." | Hook. No Hermes UI yet. Keep it to one idea. |
| 0:15 to 0:30 | Hermes landing page, click Sign in, Privy email login, enter the code. Onboarding step 1 shows the new wallet address. Click add signer, approve the Privy prompt. | "Hermes is that missing link. I sign in with email through Privy and a Monad wallet is created for me. One prompt lets the Hermes server act as a signer on that wallet, but only inside a policy." | Show the address. The signer prompt is the "beyond login" moment, so linger on it for two seconds. |
| 0:30 to 0:55 | Wallet page, policy card (chain 10143, zero native value, Exchange, AUSD approve cap, expiry). Click the policy demo. The row appears as "Denied by policy" with Privy's message. Then onboarding step 2: Get AUSD, Approve, Create account, Allow forwarding rows turn to confirmed with hashes. Click one hash to open the Monad explorer. | "The policy is enforced by Privy, not by us. Chain 10143 only, no native value, only the Perpl exchange and the AUSD token, an approve cap, and an expiry. Watch: I ask the server to send MON to a random address. Privy refuses it. Now the allowed path: approve, create my Perpl account, allow order forwarding. Three transactions on Monad testnet, signed under that policy." | The denial has no hash because nothing is broadcast. Say so in one clause if there is room. Capture the three hashes for the README. |
| 0:55 to 1:10 | Onboarding step 3: open testnet.perpl.xyz/apikeys in another tab (already created, trade scope visible), paste the key into Hermes, "Connected" with latency and head block in the top bar. | "Next I connect Perpl with a trade-only API key. Perpl designed these keys so they can place orders but never withdraw. Hermes validates it by signing in, then stores it encrypted." | Do not show the secret half of the key. Cut the paste with a blur or a jump cut if needed. |
| 1:10 to 1:30 | Onboarding step 4 / Strategies: create "BTC breakout 1m", copy webhook URL and template. Switch to TradingView: new alert, Notifications tab, paste the Webhook URL, paste the message, Create. | "Then a strategy. Hermes gives me a webhook URL and a message template with a secret. I paste both into a normal TradingView alert. Hermes executes on Perpl while the chart runs on Binance, because TradingView does not list Perpl." | Blur or crop the secret. Alert already armed, see checklist. |
| 1:30 to 1:55 | Live page, full width. The TradingView alert fires (or Send test alert). A row appears and its lifecycle bar fills: received, verified, checked, sent, accepted, filled, with millisecond labels and the total. Click the row: alert detail, then the fill's transaction hash opens in the Monad explorer. | "Now the alert fires. Received, verified, risk checked, sent to Perpl, accepted, filled. The total is [read the number on screen] milliseconds from alert to fill. And this is the fill on Monad: a real transaction on Perpl's exchange." | This is the money shot. Hold on the lifecycle bar for three seconds. If the real number is above one second, say the real number. |
| 1:55 to 2:10 | Send an alert for a market that is not allowed (DOGE), or one over the max size. Row stops at "Checked" with a red segment and the label "Market not in your allowed list". | "Not every alert should trade. This one asks for a market I have not allowed. Hermes stops it before anything reaches Perpl, and the reason is recorded." | See the checklist for the curl command. |
| 2:10 to 2:30 | Send a USD 1,000 alert with the approval threshold set to 500. Row shows "Needs approval" with a countdown. Open Approvals, click Approve. The row continues to filled. | "Large orders wait for me. This one is above my approval threshold, so nothing is sent until I say so. I approve it, and it goes through." | Approvals expire after 120 s by default (a limit you can change), so keep this take quick. |
| 2:30 to 2:48 | Report card for the strategy: grade, median and p95 alert-to-fill, slippage against the alert price, blocked and missed alerts with reasons. | "And the report card. For each strategy: the alert price against the fill price, how long it took, and every alert that did not become a trade, with the reason. That is how you find out whether your strategy performs live the way it looked on the chart." | Use real data from the live run, or the seeded history if it is clearly labelled. Do not present seeded data as live. |
| 2:48 to 2:55 | Hermes logo and GitHub URL on screen. | "Hermes: TradingView alerts to Perpl orders, inside your limits. This is on the Perpl co-founder's own roadmap." | Say exactly that sentence. Do not say he asked for it or that Perpl endorses the project. His roadmap item is "PineScript compatibility for TradingView strategies"; Hermes builds the alert-to-order form of it. |

Total voice-over: about 380 words at a calm pace. If the first take runs long, cut the "Perpl API key" shot to a jump cut and trim the hook, not the live alert.

## Pre-recording checklist

Funds and accounts
- [ ] Wallet has testnet MON for gas (https://faucet.monad.xyz) and at least 100 AUSD, plus a few hundred more for orders and top-ups.
- [ ] A fresh Privy user for the take that shows sign-in and the wallet (or record onboarding on a clean account, and the trading shots on the funded one).
- [ ] Perpl account exists, order forwarding is on, and the trade-only API key is created and ready to paste.
- [ ] Backend runs outside the US/GB and is not answering 451 (the top bar shows Perpl connected with a latency).

Proof captured
- [ ] Transaction hashes saved for: AUSD approve, createAccount, allowOrderForwarding, one order fill. Paste them into the table in the [README](../README.md#testnet-transactions) and into [SUBMISSION.md](SUBMISSION.md).
- [ ] The policy-denied attempt is captured: the `denied_by_policy` row text and Privy's error message saved.
- [ ] Each hash opens on `https://testnet.monadexplorer.com/tx/<hash>` and shows success.

TradingView
- [ ] Paid plan and 2FA are on. The alert is armed on a 1 minute chart of the same asset on another exchange (for example `BINANCE:BTCUSDT.P`), with the Hermes webhook URL and message pasted in.
- [ ] The tunnel is running (`cloudflared tunnel --url http://localhost:8787`) and `PUBLIC_BASE_URL` matches it. Check by opening `<PUBLIC_BASE_URL>/healthz`.
- [ ] Fallback if TradingView does not fire in time: **Send test alert** on the strategy page. It posts the same message through the same endpoint. Say "test alert" in the voice-over if you use it.

Demo state
- [ ] Risk limits set for the take: BTC allowed, DOGE not allowed, approval threshold 500 USD, max position high enough for the 1,000 USD order, daily loss stop untouched.
- [ ] Blocked alert ready (secret from the strategy page, never shown on screen):
  `curl -X POST "$PUBLIC_BASE_URL/hooks/<strategyId>" -d '{"secret":"<secret>","action":"buy","market":"DOGE","size_usd":"100","price":"0.2"}'`
- [ ] Large alert ready: the same call with `"market":"BTC","size_usd":"1000"`.
- [ ] A few earlier fills exist so the report card has data, from real runs where possible.
- [ ] Browser: dark theme, zoom 100 to 110 percent, notifications off, no personal tabs or bookmarks visible, window at 1920 by 1080.
- [ ] No secrets on screen: webhook secret, Privy app secret, API key secret, `.env` files, terminal history.

Recording
- [ ] Record each shot separately, then cut. Keep the live alert shot as one unbroken take.
- [ ] Final length is under 3:00 on the exported file. Upload as public. Check the link in a private window.
