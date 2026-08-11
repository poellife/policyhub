# PolicyHub on Render — step by step

Follow these in order. Budget 30–40 minutes the first time. You do not need to
write any code; you're filling in forms.

**What you'll end up with:** a private web address like
`https://policyhub.onrender.com` that asks for your email and password, with your
policy data in a backed-up PostgreSQL database.

**What it costs:** $13/month — a Starter web service at $7 and a Basic-256mb
Postgres at $6. Don't use the free Postgres tier: it deletes itself after 30 days.

---

## Step 1 — Unzip the app

Download `policyhub.zip` and unzip it. You'll get a folder called `policyhub`
containing `package.json`, `src`, `public`, and a few other files.

Open that folder. You should see `package.json` sitting right there. That matters
in step 3.

---

## Step 2 — Create a GitHub account and repository

Render deploys from GitHub. A private repository is free.

1. Go to [github.com](https://github.com) and sign up (skip if you have an account).
2. Click the **+** in the top right → **New repository**.
3. Name it `policyhub`.
4. Select **Private**. This matters — it's your code and configuration.
5. Leave every checkbox unticked ("Add a README", ".gitignore", "license" — all off).
6. Click **Create repository**.

---

## Step 3 — Upload the app to GitHub

On the empty repository page, click the **uploading an existing file** link
(it's in the line "…or upload an existing file").

Now open your unzipped `policyhub` folder and **select everything inside it** —
all the files and folders, including the hidden `.env.example` and `.gitignore` if
your computer shows them. Drag that selection onto the GitHub upload area.

> **Important:** upload the *contents* of the folder, not the folder itself.
> When you're done, `package.json` must be visible at the top level of the
> repository. If you instead see a single `policyhub` folder, delete it and
> re-upload the contents.

Wait for the files to finish uploading, then click **Commit changes** at the bottom.

*Don't worry about `.env` — it isn't in the zip. Your passwords go into Render's
settings, never into GitHub.*

---

## Step 4 — Create your Render account

1. Go to [render.com](https://render.com) → **Get Started**.
2. Sign up **with GitHub**. This links the two accounts so Render can see your repo.
3. When GitHub asks which repositories Render may access, grant access to
   `policyhub` (or "All repositories" — either is fine).

---

## Step 5 — Create the database FIRST

Create the database before the web service, so its address is ready to paste.

1. In the Render dashboard, click **+ New** → **Postgres**.
2. Fill in:
   - **Name:** `policyhub-db`
   - **Database / User:** leave the defaults
   - **Region:** pick the one closest to you — **and remember it.** The web service
     must be in the same region or they can't talk over the private network.
   - **PostgreSQL Version:** leave the default
   - **Instance Type:** **Basic-256mb ($6/month)**
3. Click **Create Database** and wait for the status to become **Available**
   (usually a minute or two).
4. Once it's available, find the **Connect** button or the *Connections* section
   and copy the **Internal Database URL**. It looks like
   `postgresql://policyhub:LONGPASSWORD@dpg-xxxxx-a/policyhub_db`.

   Paste it somewhere temporary — you need it in the next step. **Use the
   Internal URL, not the External one.**

---

## Step 6 — Create the web service

1. **+ New** → **Web Service**.
2. Choose **Git Provider**, find `policyhub` in the list, click **Connect**.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | **Name** | `policyhub` (this becomes your web address) |
   | **Region** | **the same region you picked for the database** |
   | **Branch** | `main` |
   | **Root Directory** | leave blank |
   | **Language** | **Node** |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | **Starter ($7/month)** |

   > If Render preselects **Docker** as the language, change it to **Node**. The
   > repo contains a Dockerfile for portability and Render sometimes picks it up.
   > Either works, but Node is simpler and the commands above assume it.

   > Don't pick the Free instance type — free services fall asleep after 15
   > minutes and take a minute to wake up.

4. Scroll to **Environment Variables** and add these six, one at a time:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Internal Database URL you copied in step 5 |
   | `SESSION_SECRET` | a long random string — see the note below |
   | `ADMIN_EMAIL` | `JP@poelcapital.com` |
   | `ADMIN_PASSWORD` | a strong password you choose, 10+ characters |
   | `ADMIN_NAME` | `Jonathan Polter` |
   | `NODE_ENV` | `production` |

   Check each value for stray spaces at the start or end — pasted URLs often pick
   one up, and it causes a confusing connection error.

5. Open **Advanced** and set **Health Check Path** to `/api/health`. This lets
   Render restart the app automatically if it ever stops responding.

6. Click **Create Web Service**.

Render will now install and start the app. The log window shows progress; the
first deploy takes 2–5 minutes. You're looking for these two lines:

```
[init] created first admin user: jp@poelcapital.com
PolicyHub running on http://localhost:3000
```

The app creates all its database tables by itself on that first run.

---

## Step 7 — Sign in

At the top of the service page is your address, something like
`https://policyhub.onrender.com`. Open it.

Sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you set in step 6.

---

## Step 8 — Lock it down (do this now, not later)

1. **Change your password.** In the app: **Settings → Change your password**.
2. **Delete the `ADMIN_PASSWORD` variable.** Back in Render: your web service →
   *Environment* → delete that row → save. It's only read when the database is
   empty, so it's dead weight after first login — and it's your password sitting
   in a settings screen.
3. **Turn on backups.** Your `policyhub-db` → *Backups* (or *Recovery*) → confirm
   daily backups are enabled. Do this **before** you import real data.

---

## Step 9 — Load your policies

1. Export your policy list from SmartOffice as a CSV.
2. In PolicyHub, go to **Import**.
3. Leave the type as **Policies (and current values)**.
4. Set **"Values as of" date** to the date your export reflects.
5. Drop the CSV in. You'll get a preview showing which of your columns were
   matched and which were ignored — **read this before continuing.** Nothing is
   written until you click Import.
6. Click **Import**. You'll get a count of policies created, value snapshots
   written, and any rows that had problems.

If a column you care about shows up as "ignored", tell me its exact header and
I'll add it to the matcher.

---

## Your monthly routine

Export from SmartOffice → **Import** → set the as-of date → upload.

Policies are matched on policy number + carrier, so this **updates** your existing
records rather than duplicating them, and files a fresh AV / CSV / COI snapshot
for that month. That's what builds the value-history charts over time — after
three or four months you'll have trend lines the current system can't show you.

To load history you already have, put it in a file with `Policy Number`,
`As Of Date`, `AV`, `CSV`, `COI` and import it as **Value snapshots only**. Past
premium payments go in as **Transactions**.

---

## If something goes wrong

**The deploy fails, or the log says `ECONNREFUSED` / `ENOTFOUND`**
`DATABASE_URL` is wrong or has a stray space. Re-copy the **Internal** Database
URL and confirm the web service and database are in the **same region**.

**The page loads but says "Something went wrong"**
Check the service log for a Postgres error. Most often the database was still
provisioning when the app first started — click **Manual Deploy → Deploy latest
commit** to retry.

**"Incorrect email or password" on the very first sign-in**
The first admin is only created when the `users` table is empty. If you changed
`ADMIN_EMAIL` after the first successful start, the original account is still the
live one. Use the original email, or open the database's *Shell* (psql) tab and
run `DELETE FROM users;` then redeploy.

**"Too many failed attempts"**
Eight bad passwords in 15 minutes locks that email + IP combination. Wait it out,
or redeploy — the counter lives in memory.

**Everyone gets signed out unexpectedly**
`SESSION_SECRET` changed. Sessions also expire on their own after 12 hours.

**You need to update the app later**
Upload the changed files to GitHub; Render redeploys automatically. Your data is
in Postgres and isn't touched by a redeploy.

---

## About that SESSION_SECRET

It's the key that signs your login cookie — anyone who knows it could forge a
session, so it should be long, random, and private.

To make your own: open Terminal (Mac) and run `openssl rand -base64 48`, or use a
password manager's generator set to 50+ characters. Either is better than
inventing one by hand.

If you ever need to sign every user out immediately, change this value and
redeploy.
