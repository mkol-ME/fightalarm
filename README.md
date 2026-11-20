# fightalarm

Free, personal per-fight UFC alerts. Polls ESPN's public scoreboard every 30 s during a card and pushes to your phone through [ntfy](https://ntfy.sh):

- **UP NEXT** (urgent) when the bout before yours ends, about 10 min before walkouts
- **LIVE** when a bout starts
- **Result** when a bout ends
- **Armed** when it starts watching a card, so you know it's working

Pick which fights you care about on the picker page (`docs/index.html`, served by GitHub Pages). The alerts above go to picked fights only.

If every fight is picked, or nothing is picked, you get **segment mode** instead: one urgent alert per segment (early prelims, prelims, main card). The first segment alerts ~10 min before its scheduled start. Each later segment alerts when the last fight of the segment before it ends.

## How picks flow

Picker page → private ntfy topic (`PICKS_TOPIC`, kept 12 h by ntfy) → read by `fightalarm.mjs` every run and every 30 s during a card → saved to `docs/watch.json` and committed by the workflow so picks made days early survive.

## Setup

1. Install the **ntfy** app and subscribe to your alert topic. Don't subscribe to the picks topic. Topics are public, so use unguessable names.
2. Push this repo to GitHub (public repos get unlimited Actions minutes) and enable Pages from `main` → `/docs`.
3. Repo secrets: `NTFY_TOPIC` (alerts) and `PICKS_TOPIC` (picks).
4. On your phone, open `https://<user>.github.io/fightalarm/#<PICKS_TOPIC>` once, then Share → Add to Home Screen. The topic is remembered after that.

## Local use

```sh
NTFY_TOPIC=your-topic node fightalarm.mjs        # run during a card
DRY_RUN=1 LEAD_MIN=100000 node fightalarm.mjs    # print instead of push
node test.mjs saved-scoreboard.json              # replay a fake fight night
```

GitHub disables scheduled workflows on public repos after 60 days without a commit. Saving picks commits, so regular use keeps it alive.
