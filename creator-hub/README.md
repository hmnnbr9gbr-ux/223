# StreamHub — a resellable creator link page

A single-file, dependency-free "link in bio" page built for streamers and
gamers. Edit one `CONFIG` block, drop `index.html` on any free host, done.
This is a **product you can sell over and over** — every copy costs you $0.

## Why this sells (the niche)

Linktree/Beacons are generic and paywall the good stuff ($5–9/month, forever).
Small streamers want something that looks *theirs* and shows the things a
generic tool doesn't: **live badge, weekly schedule, and an affiliate gear
list** (how the creator earns). Nobody's selling a clean, gamer-native,
one-file version. That's the gap.

## How to make money with it (the ladder)

**Rung 1 — sell it as a template (fastest first dollar, passive)**
1. Make a free [Gumroad](https://gumroad.com) or [Ko-fi](https://ko-fi.com)
   account (both allow digital sales; have a parent help with payout setup —
   you're 16, so the account/payout should be in a parent's name).
2. Upload `index.html` + this guide as a zip. Price it **$7–15**.
3. Record a 30-second screen capture customizing the CONFIG block. That clip
   is your entire marketing.
4. Post the clip in streamer/creator spaces: r/Twitch, small-streamer Discords,
   TikTok with #smallstreamer. One good clip → repeat sales while you sleep.

**Rung 2 — done-for-you custom builds (higher price, uses the same file)**
- Offer "I'll set it up with your links + colors + host it for you" for
  **$25–40 each**. You just fill in their CONFIG and deploy to Netlify. 20
  minutes of work per client.

**Rung 3 — theme packs (raise the price, no new code)**
- Sell a **pack of themes** (cozy, y2k, minimal, neon) for $19. `theme-cozy.html`
  in this folder is your second theme — that's already a 2-pack.

**Rung 4 — reinvest the proceeds into the next store**
- First ~$25 of profit → a `.com` domain + a month of paid hosting so you can
  offer hosting as part of the custom-build tier, or seed a Discord-bot
  micro-SaaS (recurring revenue — the real compounding engine).

## Customizing (for the buyer, or for you)

Open `index.html`, scroll to `const CONFIG = {`. Change:
- `name`, `handle`, `tagline`, `avatarInitials`
- `theme.accent` / `theme.accent2` — any hex colors
- `isLive` — show/hide the LIVE badge
- `links` — each has `icon`, `label`, `sub`, `url`; set `primary:true` on one
- `schedule` + `liveDayIndex` — weekly times, highlight today
- `gear` — **put real affiliate links here** (Amazon Associates, etc.)

No other file to touch. Works offline. Light/dark auto + manual toggle.

## Deploying (free)

- **Netlify Drop**: drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop) — instant live URL.
- **GitHub Pages**: push to a repo, enable Pages. Free.
- **Vercel**: import the repo, deploy. Free.

## Honest note

This is the *asset*. The money comes from you shipping it, posting the clip,
and talking to a few creators. The file removes the hard part (building
something good); the selling is the part only you can do — and it's very
doable.
