# 🌐 Complete VPS Deployment & Hosting Guide

This step-by-step interactive manual walks you through deploying and hosting your Node.js **API Handler** application permanently on a Virtual Private Server (VPS) running **Linux (Ubuntu/Debian)**.

---

## 📋 Table of Contents
1. [Step 1: Connect to VPS and Install System Packages](#step-1-connect-to-vps-and-install-system-packages)
2. [Step 2: Clone Code and Setup Environment](#step-2-clone-code-and-setup-environment)
3. [Step 3: Database & Process Management (PM2)](#step-3-database--process-management-pm2)
4. [Step 4: Configure Nginx (Reverse Proxy)](#step-4-configure-nginx-reverse-proxy)
5. [Step 5: Setup Let's Encrypt SSL (HTTPS)](#step-5-setup-lets-encrypt-ssl-https)
6. [Step 6: Configure Firewall (UFW)](#step-6-configure-firewall-ufw)

---

## 🛠️ Step 1: Connect to VPS and Install System Packages

1. Open your terminal (or CMD / Git Bash) and SSH into your VPS:
   ```bash
   ssh root@YOUR_VPS_IP
   ```

2. Update your package manager:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

3. Install Node.js (v20 LTS), PM2 (Process Manager), Git, and Nginx:
   ```bash
   # Install curl and setup NodeSource Repository for Node v20
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs git nginx certbot python3-certbot-nginx build-essential

   # Verify Node & NPM are installed
   node -v
   npm -v

   # Install PM2 globally
   sudo npm install pm2 -g
   ```

---

## 📂 Step 2: Clone Code and Setup Environment

### Method A: Using Git (Highly Recommended)
1. Initialize git on your local machine and push it to a private repository on GitHub/GitLab.
2. On your VPS, navigate to the `/var/www` folder and clone it:
   ```bash
   cd /var/www
   git clone <your-repository-url> api-handler
   cd api-handler
   ```

### Method B: Using SCP (Direct Copy)
If you prefer not to use Git, copy the folder directly from your local computer:
```bash
# Run this on your local machine's Command Prompt (inside D:\Coding)
scp -r "Api handler" root@YOUR_VPS_IP:/var/www/api-handler
```

---

### Install Production Dependencies
Run this inside `/var/www/api-handler` on your VPS to install dependencies while skipping dev packages:
```bash
cd /var/www/api-handler
npm install --omit=dev
```

---

### Setup Production `.env`
Create a production `.env` file on your VPS:
```bash
nano .env
```
Copy and paste your configurations (making sure your database path is correct and your active API keys are loaded):
```env
# Vertex AI / Google Cloud API Key
GOOGLE_CLOUD_API_KEY=YOUR_SECURE_GEMINI_KEY

# Groq API Key (for Lite Engine)
GROQ_API_KEY=YOUR_GROQ_API_KEY

# Database Configuration
SQLITE_DB_PATH=./database.sqlite

# Server Configuration
PORT=3001
```
*Press `Ctrl+O` then `Enter` to save, and `Ctrl+X` to exit.*

---

## ⚡ Step 3: Database & Process Management (PM2)

### 1. Initialize and Seed the SQLite Database
Run the seeder tool to generate your database with the clean schema and seed the initial `test-user` (`sk-test-key-12345`):
```bash
node seed.js
```
*(Optional)* Create a new custom admin user interactively:
```bash
node createUser.js
```

### 2. Start the App using PM2
Start the backend server using the `ecosystem.config.js` script so it runs silently in the background:
```bash
pm2 start ecosystem.config.js
```

### 3. Setup Boot-up Persistence
To ensure your API Handler automatically boots up if the VPS reboots (e.g. during system maintenance), run:
```bash
# This generates a custom startup system command
pm2 startup
```
Copy and paste the exact command outputted by the terminal (usually starts with `sudo env PATH=...`).
Then save the current PM2 process list:
```bash
pm2 save
```

#### Handy PM2 Commands:
* Check application status: `pm2 status`
* View logs in real-time: `pm2 logs`
* Restart app: `pm2 restart api-handler`

---

## 🛡️ Step 4: Configure Nginx (Reverse Proxy)

Nginx will receive incoming traffic on standard port 80 (HTTP) and route it securely to your internal Node.js port 3001.

1. Create a new Nginx server configuration:
   ```bash
   sudo nano /etc/nginx/sites-available/api-handler
   ```

2. Copy and paste this server block (replace `api.yourdomain.com` with your actual domain):
   ```nginx
   server {
       listen 80;
       server_name api.yourdomain.com; # <--- Replace with your domain

       location / {
           proxy_pass http://localhost:3001;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           
           # Forward IP addresses to Node.js backend
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

3. Enable the configuration and test Nginx:
   ```bash
   # Enable configuration by creating a symlink
   sudo ln -s /etc/nginx/sites-available/api-handler /etc/nginx/sites-enabled/

   # Remove the default Nginx site to prevent conflicts
   sudo rm /etc/nginx/sites-enabled/default

   # Verify syntax is correct
   sudo nginx -t
   ```
   *(If it says syntax is ok, reload Nginx)*:
   ```bash
   sudo systemctl reload nginx
   ```

---

## 🔑 Step 5: Setup Let's Encrypt SSL (HTTPS)

Secure all traffic with free, auto-renewing SSL certificates:

1. Request an SSL certificate for your domain:
   ```bash
   sudo certbot --nginx -d api.yourdomain.com
   ```
2. Follow the prompt questions (enter email, accept terms). Certbot will automatically rewrite your Nginx configuration to enable HTTPs and redirect HTTP requests to HTTPS!
3. Test automatic SSL renewal (runs dry run to verify):
   ```bash
   sudo certbot renew --dry-run
   ```

---

## 🧱 Step 6: Configure Firewall (UFW)

To secure your server from external ports scanning, lock down all ports except SSH, HTTP, and HTTPS:

```bash
# Allow Nginx full traffic (Port 80 & 443)
sudo ufw allow 'Nginx Full'

# Allow SSH connections so you don't get locked out
sudo ufw allow OpenSSH

# Enable the firewall
sudo ufw enable

# Check firewall status
sudo ufw status
```

---

### 🎉 Your VPS is Ready!
You can now securely call your Vertex/Gemini completions API from any server, client, or application over secure HTTPS:

* **Completion URL**: `https://api.yourdomain.com/api/vertex/chat/completions`
* **Headers**:
  - `Authorization: Bearer <your-api-key>`
  - `Content-Type: application/json`
