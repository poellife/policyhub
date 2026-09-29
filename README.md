# My Torah Helper

Hebrew reading (kriah) practice for kids: 1,020 siddur and Chumash words in three levels, an Ashkenazi voice, a 15-minute daily goal, a race-car reward system, daily chores, and a parent view. Progress is stored in a database so they can use it from any device with the same family code.

## What's in here

| File | What it is |
|---|---|
| `public/index.html` | The whole app (one file). |
| `server.js` | Tiny Node/Express server: serves the app and a two-route API that stores each family's progress. |
| `render.yaml` | Render blueprint: creates the web service (you supply the database URL). |
| `package.json` | Dependencies (`express`, `pg`, `ffmpeg-static` for converting recordings to MP3). |
| `public/cars/` | Drop `car1.png` … `car8.png` here to replace the drawn cars with his own. |
| `public/audio/` | Optional: hand-made recordings named `w0001.mp3` … (the in-app recorder stores to the database instead). |

## Deploy on Render (from GitHub)

You need a Postgres connection string first (Render allows one free database per account, so the blueprint doesn't create one).

**Get a database — pick one:**

- **Neon (recommended, free, no expiry):** go to neon.tech → sign up → New project (name it `my-torah-helper`) → on the project page click **Connect** → copy the connection string (starts with `postgresql://…neon.tech/…?sslmode=require`).
- **Your existing free Render database:** Render dashboard → the database → **Connect** → copy the **External Database URL**. (Note: Render's free Postgres is deleted 30 days after creation.)

**Deploy:**

1. Push this folder to a GitHub repo (files at the root of the repo).
2. In Render: **New +** → **Blueprint** → choose the repo → it asks for **DATABASE_URL** → paste the connection string → **Apply**.
   (If you already have a failed blueprint from before, delete it under Blueprints first, or just use the manual route below.)
3. Wait for the first deploy (2–3 minutes). Your app is at `https://my-torah-helper.onrender.com` (or similar).
4. Open it → **Create a new family code** → type that code on his other devices.

**Manual route (no blueprint):** New + → **Web Service** → pick the repo → Runtime Node, Build command `npm install`, Start command `npm start`, plan Free → under Environment add `DATABASE_URL` = your connection string → Create.

Every push to GitHub redeploys automatically. Progress and your recordings live in the database, so redeploys never lose anything.

**Free web services go to sleep** after 15 idle minutes; the first open after that takes 30–60 seconds. The $7/month Starter plan removes this.

## Recording the words in your own voice

Open the app → Parent view (eye icon) → **🎙 Record the words**. It shows one word at a time with its reading; tap ● , say the word, tap ■. It uploads, trims the silence, converts to MP3 and moves to the next unrecorded word. Space bar records/stops, arrow keys move, P plays back. Filter by level (record Simple first — that's where he is). Recordings are stored in the database and play on every device; the computer voice is used only for words you haven't recorded yet.

You can also record elsewhere and drop files into `public/audio/` named `w0001.mp3` … `w1020.mp3` (the spreadsheet lists which is which).

## Run it on your own computer

```
npm install
npm start
```
Open http://localhost:3000. Without `DATABASE_URL` it stores progress in `data/families.json`.

## How sync works

- Each family has a code like `MOISHY-7K3PX2`. The code is the password: anyone who knows it can see and change that family's progress, and nothing else.
- The app saves after every answer (`PUT /api/family/CODE`) and checks for changes every 4 seconds (`GET /api/family/CODE?since=rev`), so two devices stay in step.
- If the server can't be reached, the app keeps working from the copy on the device and catches up when it can.

## Voice

There is no Ashkenazi text-to-speech anywhere, so the app uses the device's **English** voice to read the Ashkenazi sounds ("baw-rookh", "shah-baws"). Built-in computer voices vary enormously: open **Parent view → Voice** and press ▶ next to each voice to hear it, then "Use" the best one. Voices named **Natural** (Microsoft Edge), **Google** (Chrome) or **Samantha/Ava** (Mac, iPad) sound far better than the old Windows/Linux defaults. On an iPad the default is already good.
