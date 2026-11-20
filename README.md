# LinkedIn Autoposter

A personal app that grows your LinkedIn presence for you. It checks how healthy
your profile is, works out what you should be known for, and writes a new post
draft every day that fits your profile. You approve each post, and the app
publishes it on your schedule.

**Status, 19 November 2026:** working on your Mac, connected to LinkedIn, and
publishing for real. The first real post went out on 18 November. Each person now
has their own login, and daily drafts can post automatically. Next step: hosting.
See [Development status](#development-status).

## The idea

Posting regularly on LinkedIn takes time, and generic AI posts don't build a
reputation. This app aims to post things that strengthen the specific position
your profile is building, with as little effort from you as possible.

1. **Profile health check.** You upload your profile, and the AI scores each
   section, explains what's holding it back, and suggests better wording. It also
   defines your positioning (the one thing you should be known for) and your
   target audience.
2. **Content themes.** From your profile, the app proposes 3 or 4 recurring
   themes. For a Forward Deployed Engineer (FDE), for example:
   - **The ideal FDE:** what excellent work in the role looks like.
   - **New for FDEs:** recent developments in the field, researched on the web
     with sources attached.
   - **What I'm learning:** honest posts about what you're learning, which also
     promote it.
3. **A draft every day.** The app writes one draft a day, taking turns through
   your themes and avoiding repeats of recent posts. You can also type any topic
   and get a draft on demand.
4. **You approve, or it posts by itself.** You edit, rewrite or approve each
   draft, and it goes out in your next posting slot, such as every day at 9:00.
   If you're busy, turn on **Post daily drafts automatically** and each day's
   draft is scheduled without waiting for you.
5. **Connect once.** Link your LinkedIn account, or several accounts, and the app
   keeps working. Reconnecting takes one click when LinkedIn asks.
6. **For family and friends too.** Invite people with a link. Each person gets
   their own login and only sees their own LinkedIn accounts and posts.

Some principles guide the design:

- **Nothing invented:** posts use only facts from your profile and notes. The AI
  must not make up personal stories, experiences, results or statistics, and
  researched posts list the sources they relied on.
- **You stay in control:** daily drafts wait for your approval unless you turn on
  automatic posting. A dry-run mode lets you try everything without posting.
- **Only official access:** the app uses LinkedIn's official API. It never
  scrapes LinkedIn, which would risk your account.

## How it works

```
Profile PDF ──► Profile check ──► Positioning, audience, themes
                                          │
Your topic ─┐                             ▼
            ├──────► AI writes a draft ◄── Daily timer (one theme per day)
            │              │
            │              ▼
            └────── You review: edit, rewrite, approve
                           │
                           ▼
                 Scheduled ──► Published on LinkedIn
```

- **Stack:** Node.js 24, Express, and SQLite built into Node (`node:sqlite`), with
  a plain HTML, CSS and JavaScript front end. No build step.
- **AI:** Claude Sonnet 5.5 by default, through the official Anthropic SDK. Grok is
  supported as an alternative. Researched posts use the AI's own web search.
- **Logins:** usernames and passwords stored as scrypt hashes, with a sign-in
  cookie that lasts 30 days. New people join through single-use invite links.
- **LinkedIn:** OpenID Connect sign-in and the Posts API (`/rest/posts`).
- **Scheduling:** a timer inside the app checks every 30 seconds for posts that
  are due, and every minute for daily drafts.

### Project layout

| Path | What it does |
|---|---|
| `src/index.js` | Starts the app, reads settings, picks Claude or Grok |
| `src/server.js` | Web routes, logins, invites, input checks |
| `src/auth.js` | Password hashing, sign-in tokens, and limits on password guessing |
| `src/db.js` | Database: logins, accounts, posts, settings, and the upgrade from older versions |
| `src/prompts.js` | Instructions for the AI, and the profile review format |
| `src/ai.js` | Claude: writing, profile review, web search, sources |
| `src/grok.js` | Grok: the same features through xAI's API |
| `src/daily.js` | Writes the daily drafts, rotates through themes, and schedules them when automatic posting is on |
| `src/publisher.js` | Publishes due posts, making sure each goes out only once |
| `src/linkedin.js` | LinkedIn sign-in and posting |
| `src/schedule.js` | Works out posting times in your time zone |
| `public/` | The web page |
| `test/` | Automated tests |
| `data/app.db` | Your saved data, created on first run |

## Development status

### Working, and tested for real

- **Profile check:** tested with your real profile PDF. It returned a score,
  section scores, fixes with suggested wording, positioning, audience and themes.
- **Drafts:** tested from typed topics, themes and web research. Researched posts
  include sources, and the app keeps only links that really appeared in the
  search results.
- **LinkedIn sign-in and publishing:** connected and posted for real on
  18 November 2026.
- **Error handling:** brief outages are retried automatically, with clear messages
  for a bad key, no credits, or an outage.

### Built, tested only with automated tests

- **Logins and invites:** each person has their own login and sees only their own
  accounts and posts.
- **Automatic daily posting.**
- **Claude Sonnet 5.5:** the earlier real tests used Opus 5.5. Run one draft to
  check you're happy with Sonnet's writing.
- **Grok support:** the Grok key provided earlier was rejected, so real Grok calls
  are untested.

There are 70 automated tests; run them with `npm test`.

### Current setup on this Mac

- **Running:** at http://localhost:3100. Port 3000 is taken by another app.
- **Mode:** dry run is off, so posts go to LinkedIn. LinkedIn is connected.
- **Claude credits:** the account ran out of credits, which stopped a daily
  draft. Add credits at platform.claude.com.
- **Claude connection:** your shell's `ANTHROPIC_BASE_URL` points to your own
  proxy, but this app always connects directly to Anthropic.

### Cost

Claude Sonnet 5.5 costs $2 per million input tokens and $10 per million output
tokens, half of Opus 5.5. A typical post costs about 3 cents. A researched post
costs about 8 cents, because web search is billed at $10 per 1,000 searches and
the results are long. At 60 posts a month, a quarter of them researched, that's
roughly $2.50 a month. To spend even less, set `CLAUDE_MODEL=claude-haiku-5-5`,
which is far cheaper but writes less carefully. Or remove the "news" theme, which
does the web research. These figures are estimates; your Claude Console shows
actual spending. A real researched post on 19 November cost 7.6 cents.

**Monthly limit:** the app stops calling Claude once it has spent
`MONTHLY_BUDGET_USD` in a calendar month, $3 by default, and starts again on the
1st. This covers everyone using the app. The page shows this month's spending
under **When to post**. With $10 of credits, that's at least three months.

### Known limits

These come from LinkedIn's API and can't be fixed in this app:

- **Profile access:** only approved LinkedIn partners can read profile data, so
  the profile comes from a PDF you upload. The PDF doesn't include your photo,
  banner, Featured section or activity, so those aren't checked.
- **Reconnecting:** automatic token renewal is for approved partners only, so each
  person reconnects about every 60 days.
- **Post statistics:** reading them needs a separate LinkedIn permission that I
  haven't confirmed apps like this can get. Until then, the app can't learn from
  what performed well.
- **Text only:** posts are text-only. Images aren't supported yet.

Other notes:

- **Not a LinkedIn score:** the health score is the AI's review, not a LinkedIn
  metric.
- **Must be running:** drafts and posts only happen while the app runs. Anything
  that came due while it was off happens late, when it starts again.
- **Forgotten passwords:** there's no email reset. The owner creates a password
  reset link under **People**.

### Next steps

1. Add Claude credits.
2. Host it on Railway so it runs all the time (see [Keep it running](#keep-it-running)).
3. Invite your first family member or friend.
4. Possible later features:
   - Learning from post statistics, if LinkedIn allows it
   - Image posts
   - Email reminders when drafts are waiting

## Setup

You need [Node.js 24 or newer](https://nodejs.org).

```bash
npm install
```

```bash
cp .env.example .env
```

Add an AI key to `.env`: either `ANTHROPIC_API_KEY` for Claude (from
https://platform.claude.com) or `XAI_API_KEY` for Grok (from https://console.x.ai).
If the Grok key is set, the app uses Grok. Then run:

```bash
npm start
```

Open the address it prints. That's http://localhost:3000 by default, or another
port if you set `PORT` and `APP_URL` in `.env`. On this Mac it's 3100.

The first time, the app asks you to create a login. You become the app's owner,
and any accounts and posts already in the app become yours.

### First use

1. **Run the profile check.** On LinkedIn, open your profile, click **More** or
   **Resources**, then **Save to PDF**. Upload that file to the app.
2. **Review the results:** your score, the fixes that matter most, positioning,
   audience and themes.
3. **Open Schedule, themes and writing style.** Fill in what you're learning,
   adjust the themes, set your posting days and time, and paste a past post or two
   as a style example.
4. **Approve drafts.** A new draft appears each day, and **Draft from my next
   theme** gives you one right away.

Daily drafts wait for your approval unless **Post daily drafts automatically** is
on. With it on, each daily draft is scheduled for your next posting time, so set
the draft time an hour or two earlier if you'd like a chance to read it first.
A researched post with nothing to cite is still posted. The writing instructions
make it a general post in that case, with no claims about recent releases, dates
or numbers. New accounts start with automatic posting on weekdays at 11:00.
If writing a draft fails because the connection dropped, for example because the
Mac went to sleep mid-request, the app tries again 10 minutes later, up to three
tries a day. If three daily posts are waiting, as drafts or scheduled, the app stops writing
more until some are dealt with, so you aren't paying for posts that pile up.

### Connect LinkedIn

1. Go to https://www.linkedin.com/developers/apps and choose **Create app**.
   LinkedIn requires a Company Page. If you don't have one, the form links to
   where you can create one, and it can be empty.
2. On the **Products** tab, add **Share on LinkedIn** and
   **Sign In with LinkedIn using OpenID Connect**.
3. On the **Auth** tab, add your app's address followed by
   `/auth/linkedin/callback` under **Authorized redirect URLs**. On this Mac
   that's `http://localhost:3100/auth/linkedin/callback`.
4. Copy the **Client ID** and **Client Secret** from the Auth tab into `.env`.
5. Restart the app and click **Connect LinkedIn**.
6. When you're ready to post for real, set `LINKEDIN_DRY_RUN=false` in `.env`
   and restart. Use **Post now** on one test post to confirm it works.

The app warns you a week before your LinkedIn connection expires, and you click
**Reconnect**. Your posts and settings stay in place.

### Adding family and friends

Nobody else needs their own LinkedIn developer app. Your app works for any
LinkedIn member who clicks **Allow**.

1. Open **People** at the bottom of the page and click **Create invite link**.
2. Send the link to the person. It works once and expires after 7 days.
3. They open it, choose a username and password, and click **Connect LinkedIn**.
   They should do this on their own device, signed in to their own LinkedIn.
4. They upload their profile PDF and pick their settings, just as you did.

Each person sees only their own accounts and posts, and their own Claude usage
comes out of your Claude credits. If someone forgets their password, click
**Password reset link** next to their name and send them the link. To add a
second LinkedIn profile under your own login, click **Add account**. LinkedIn
uses whichever profile is signed in to the browser, so sign out of LinkedIn first.

### Keep it running on your Mac (free)

`scripts/mac-service.sh install` runs the app in the background. It starts when
you log in, restarts if it crashes, and stops the Mac from sleeping while it
runs. A sleeping Mac can't write or publish posts. Closing the lid still puts
most Macs to sleep, so leave it open. Use `status`, `logs`, `restart` and
`uninstall` the same way. Run `restart` after changing `.env`.

To let other people reach it, use a free [ngrok](https://ngrok.com) account:

1. Run `brew install ngrok`, sign up at ngrok.com, and run the
   `ngrok config add-authtoken ...` command from your ngrok dashboard.
2. In the dashboard under **Domains**, claim your free domain. It stays the same
   every time, so links and LinkedIn's redirect URL keep working.
3. In `.env`, set `APP_URL=https://YOUR-DOMAIN` and choose a `SETUP_CODE`.
4. Add `https://YOUR-DOMAIN/auth/linkedin/callback` to your LinkedIn app's
   redirect URLs.
5. Run `scripts/mac-service.sh install` again. It now runs the tunnel too.
6. Use `https://YOUR-DOMAIN` from then on, including yourself, and sign in again.

ngrok's free plan shows a warning page the first time each browser visits. Click
**Visit Site** to continue.

Posts only go out while the Mac is on. A post that came due while it was off
goes out as soon as it's back. Pick posting days and times when the Mac is
usually on.

### Host it instead

To have it run all the time, host it somewhere that keeps a server running and
keeps files between restarts, such as [Railway](https://railway.com) or
[Render](https://render.com). Serverless hosts such as Vercel won't work, because
this app needs a background timer and a saved database.

1. Put this project in a GitHub repository and create a service from it.
2. Add a persistent volume and set `DATA_DIR` to its mount path.
3. Set these environment variables: `ANTHROPIC_API_KEY`, `LINKEDIN_CLIENT_ID`,
   `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_DRY_RUN`, `APP_URL` (your public address)
   and `SETUP_CODE`.
4. Add `https://YOUR-ADDRESS/auth/linkedin/callback` to your LinkedIn app's
   redirect URLs.
5. Open the address and create your login, entering the setup code.

The app won't start on a public address without `SETUP_CODE`, because otherwise a
stranger who found the page first could create the owner login.

## Good to know

- **Failed posts:** these return to Drafts with the reason, and they aren't
  retried automatically, so a post can't go out twice by accident. If a post
  shows "Publishing…" for a long time, check LinkedIn before posting it again.
- **Posting without review:** **Post topics without review** schedules drafts
  from topics you type, and **Post daily drafts automatically** does the same for
  daily drafts. Both are off by default, because AI can get things wrong under
  your name.
- **Your data:** drafts, profile summaries and LinkedIn access tokens are saved
  unencrypted in `data/app.db`. Passwords are stored only as hashes. Never share that file or `.env`, and keep both
  out of any Git repository; `.gitignore` already excludes them.
- **Cost:** researched posts cost more because web search is billed separately.
  To change models, set `CLAUDE_MODEL` or `GROK_MODEL`. You can also turn daily
  drafts off in settings.
- **With Grok:** the app reads the text out of your PDF on your computer and sends
  only that text, so a scanned PDF won't work. Paste your profile instead.
- **LinkedIn API version:** LinkedIn retires versions after about a year. If posts
  start failing with a version error, update `LINKEDIN_API_VERSION` in `.env`.
