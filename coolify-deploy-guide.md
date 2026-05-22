# 🚀 Coolify Deployment Guide (Self-Hosted VPS)

Since you are using **Coolify** on your VPS, deploying your API Handler is incredibly easy and automated! Coolify will handle Nginx reverse proxying, Let's Encrypt SSL, process auto-restarts, and Git webhooks automatically.

Because we are using **SQLite**, the most critical step is configuring a **Persistent Volume** in Coolify so that your database file (`database.sqlite`) is never deleted when you redeploy.

---

## 📋 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Step 1: Create a New Application in Coolify](#step-1-create-a-new-application-in-coolify)
3. [Step 2: Set up Persistent Storage (Crucial for SQLite!)](#step-2-set-up-persistent-storage-crucial-for-sqlite)
4. [Step 3: Add Environment Variables](#step-3-add-environment-variables)
5. [Step 4: Configure Port & Build Pack](#step-4-configure-port--build-pack)
6. [Step 5: Run Seeder / Register Users](#step-5-run-seeder--register-users)

---

## 1. Prerequisites
- Push your clean git repository to GitHub, GitLab, or a self-hosted Git instance.
- Ensure your `.gitignore` is pushed (so `node_modules` and `database.sqlite` are **not** pushed to Git).

---

## Step 1: Create a New Application in Coolify
1. Go to your Coolify Dashboard.
2. Select your **Project** and **Environment**.
3. Click **+ New Resource** -> **Application** -> **GitHub/GitLab Repository** (or **Public Git** if it is a public repository).
4. Select your `api-handler` repository and the `main` branch.
5. Click **Save**.

---

## Step 2: Set up Persistent Storage (Crucial for SQLite!)
By default, Docker containers are ephemeral, meaning your database will be wiped out every time you redeploy the app. To prevent this, we must mount a persistent volume:

1. In your Coolify Application settings, go to the **Storage** tab.
2. Click **+ Add Volume**.
3. Configure the volume:
   - **Volume Name**: `api-handler-db`
   - **Mount Path**: `/data` (This is where the database file will live inside the container).
4. Save the volume.

---

## Step 3: Add Environment Variables
Go to the **Environment Variables** tab in Coolify and paste the following keys:

| Key | Value | Description |
| :--- | :--- | :--- |
| `PORT` | `3001` | The internal port the server listens on |
| `SQLITE_DB_PATH` | `/data/database.sqlite` | **Crucial:** Directs SQLite to save the DB inside our persistent volume! |
| `NIXPACKS_NODE_VERSION` | `20` | **Crucial:** Tells Nixpacks to build with Node 20+, which is required for `better-sqlite3` |
| `GOOGLE_CLOUD_API_KEY` | `your-gemini-key` | Your Google Vertex/Gemini API Key |
| `GROQ_API_KEY` | `your-groq-key` | Your Groq API Key (for Lite Engine) |

---

## Step 4: Configure Port & Build Pack
Coolify uses **Nixpacks** by default, which automatically detects your `package.json`, installs production packages, and executes `npm run start` (which runs `node index.js`).

1. Go to the **Configuration** -> **General** tab.
2. In the **Ports Exposing** field, set the port to **`3001`**.
3. Under **Domain**, enter your preferred domain (e.g. `api.yourdomain.com`). Coolify will automatically request a Let's Encrypt SSL certificate and set up HTTP to HTTPS redirection!
4. Click **Deploy**.

> [!NOTE]
> We have included a **[`nixpacks.toml`](file:///d:/Coding/Api%20handler/nixpacks.toml)** file in the repository root. This tells Coolify's build engine to automatically install `python3`, `gnumake`, and `gcc` during setup, enabling the SQLite driver (`better-sqlite3`) to compile successfully without any manual server intervention!

---

## Step 5: Run Seeder / Register Users
Once the application successfully deploys for the first time, your database structure will automatically initialize. Now you need to seed the database and add users:

1. In the Coolify Application dashboard, go to the **Terminal** tab (or **Exec** tab).
2. Open the interactive terminal inside your container (`/bin/sh` or `/bin/bash`).
3. Run the **seeder command** to create the test user profile:
   ```bash
   node seed.js
   ```
4. Run the **user creator script** to add your custom user keys:
   ```bash
   node createUser.js
   ```

### 🎉 You are Done!
Your API Handler is now hosted securely on your VPS via Coolify. You can access it securely over HTTPS at:
`https://api.yourdomain.com/api/vertex/chat/completions`
