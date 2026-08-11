# Getting PolicyHub online

Plain-language setup. Budget about 30 minutes the first time.

You need three things: somewhere to run the app, a PostgreSQL database, and a
web address. The two hosts below bundle all three.

---

## Option A — Railway (simplest)

Railway creates the database for you and wires it to the app automatically.

**Cost:** the Hobby plan is $5/month and includes $5 of usage credit. An app this
size plus a small Postgres database typically lands inside that credit, so expect
around $5–10/month. Pro is $20/month if you later want team seats.

### Steps

1. **Put the code somewhere Railway can read it.** Create a free private repository
   on [github.com](https://github.com) and upload the contents of this folder to it.
   (If you'd rather not use GitHub, Railway's CLI can deploy straight from your
   computer — but GitHub is easier to update later.)

2. **Create the project.** Sign up at [railway.app](https://railway.app) → *New
   Project* → *Deploy from GitHub repo* → pick your repository.

3. **Add the database.** In the same project, click *New* → *Database* → *Add
   PostgreSQL*. Railway provisions it and exposes a `DATABASE_URL`.

4. **Point the app at the database.** Open your app service → *Variables* → *New
   Variable* → *Add Reference* → choose the Postgres service's `DATABASE_URL`.

5. **Add the remaining variables** on that same screen:

   | Name | Value |
   |---|---|
   | `SESSION_SECRET` | a long random string — see "Generating a secret" below |
   | `ADMIN_EMAIL` | `JP@poelcapital.com` |
   | `ADMIN_PASSWORD` | a strong password, at least 10 characters |
   | `ADMIN_NAME` | `Jonathan Polter` |
   | `NODE_ENV` | `production` |

6. **Get your address.** Settings → *Networking* → *Generate Domain*. You'll get
   something like `policyhub-production.up.railway.app`, served over HTTPS.

7. **Sign in** with the admin email and password you set, then go to **Settings →
   Change your password** and set a new one. Delete `ADMIN_PASSWORD` from the
   variables afterwards — it's only read when the database is empty.

8. **Turn on backups.** Postgres service → *Settings* → enable scheduled backups.
   Do this before you load real data.

---

## Option B — Render

**Cost:** roughly $13/month minimum — a Starter web service at $7/month plus a
Postgres instance from $6/month. Render's free Postgres tier expires after 30 days,
so it isn't suitable for real data.

1. Push the code to a GitHub repository (as in step 1 above).
2. At [render.com](https://render.com): *New* → *Postgres*. Name it, pick a paid
   plan, create it. Copy the **Internal Database URL**.
3. *New* → *Web Service* → connect the repository.
   - Build command: `npm install`
   - Start command: `npm start`
4. Under *Environment*, add `DATABASE_URL` (the internal URL you copied) plus
   `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, and
   `NODE_ENV=production`.
5. Deploy, then open the `onrender.com` address Render gives you and sign in.
6. Change your password in Settings and remove `ADMIN_PASSWORD`.

A `render.yaml` is included, so you can also use Render's *Blueprint* flow and it
will read most of this configuration automatically.

---

## Generating a secret

`SESSION_SECRET` signs the login cookie. It should be long and random — if someone
learns it they can forge a session. Any of these produce a good one:

- macOS / Linux terminal: `openssl rand -base64 48`
- Or use a password manager's generator set to 50+ characters

Keep it out of email and out of the repository. If you ever need to sign everyone
out immediately, change this value and redeploy.

---

## After you're live

**Load your data.** Export your policy list from SmartOffice as CSV, then go to
**Import** and upload it as *Policies (and current values)*. The preview shows which
columns matched before anything is written. Set the "Values as of" date to the date
your export reflects.

**Each month**, export again and upload the same way. Policies are matched on policy
number plus carrier, so existing records update rather than duplicate, and a new
value snapshot is added for that month — which is what builds the AV / CSV / COI
history charts over time.

**Backfilling history.** If you have older monthly figures, put them in a file with
`Policy Number`, `As Of Date`, `AV`, `CSV`, `COI` and import it as *Value snapshots
only*. Same for past premium payments as *Transactions*.

**Adding people.** Settings → Users. Roles are `admin` (everything, including users
and the activity log), `editor` (can change data), and `viewer` (read-only).

---

## Things worth knowing

- **Backups are the host's job, and turning them on is yours.** Do it before real
  data goes in, and check once that a restore works.
- **The activity log** records every change with a user and timestamp. It's in
  Settings, admin-only.
- **Nothing is shared with anyone.** The app makes no outbound calls; it loads no
  fonts, scripts, or trackers from other servers.
- **If you get locked out**, connect to the database from your host's console and
  either delete the `users` row and restart the app (it'll re-seed from
  `ADMIN_EMAIL` / `ADMIN_PASSWORD`), or have another admin reset it for you.
- **Moving hosts later** is a `pg_dump` and restore — nothing is host-specific.
