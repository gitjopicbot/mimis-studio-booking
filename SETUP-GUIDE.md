# Mimi's Studio - Deployment Setup Guide

Follow these 3 steps to get the booking site live. Total time: ~20 minutes. Cost: $0/month.

---

## STEP 1: Set Up Supabase (Free Database)

1. Go to **https://supabase.com** and click "Start your project" (sign up with GitHub or email)
2. Click **"New Project"** — name it `mimis-studio`, set a password, pick the closest region
3. Wait ~2 minutes for the project to spin up
4. Go to **SQL Editor** (left sidebar) → click **"New Query"**
5. Open the file `supabase-setup.sql` from this folder, copy ALL the contents, paste into the SQL editor
6. Click **"Run"** — you should see "Success" messages
7. Now grab your keys: Go to **Settings** (gear icon) → **API**
   - Copy the **Project URL** (looks like `https://abc123.supabase.co`)
   - Copy the **anon public** key (the long string under "Project API keys")
   - Save both — you'll need them in Step 3

---

## STEP 2: Set Up Resend (Free Email)

1. Go to **https://resend.com** and sign up (free tier = 100 emails/day)
2. After signing in, go to **API Keys** in the left sidebar
3. Click **"Create API Key"** — name it `mimis-studio`, leave permissions as "Full Access"
4. Copy the API key (starts with `re_`) — save it, you'll need it in Step 3

**Note:** On the free tier, emails are sent from `onboarding@resend.dev`. This works fine for testing.
Later, if Mimi wants emails to come from her own domain (like `bookings@mimisstudio.com`), you can
add a custom domain in Resend's dashboard.

---

## STEP 3: Deploy to Netlify

### Option A: Drag & Drop (Easiest)

1. Go to **https://app.netlify.com** and sign up (free)
2. From the main dashboard, look for **"Sites"** → click **"Add new site"** → **"Deploy manually"**
3. **IMPORTANT:** Before uploading, you need to install dependencies:
   - Open a terminal/command prompt in the `mimis-studio-site` folder
   - Run: `npm install`
   - This creates a `node_modules` folder with the required packages
4. Drag the entire `mimis-studio-site` folder onto the upload area
5. Netlify will give you a URL like `https://random-name-12345.netlify.app`

### Option B: GitHub (Auto-deploys on changes)

1. Push the `mimis-studio-site` folder to a new GitHub repository
2. Go to **https://app.netlify.com** → **"Add new site"** → **"Import an existing project"**
3. Connect your GitHub account and select the repo
4. Build settings should auto-detect from `netlify.toml`
5. Click **"Deploy site"**

### Add Environment Variables (Required for both options)

1. In Netlify, go to your site → **Site configuration** → **Environment variables**
2. Add these 4 variables:

   | Key | Value |
   |-----|-------|
   | `SUPABASE_URL` | Your Supabase project URL from Step 1 |
   | `SUPABASE_ANON_KEY` | Your Supabase anon key from Step 1 |
   | `RESEND_API_KEY` | Your Resend API key from Step 2 |
   | `MIMI_EMAIL` | `picardjoseph8@gmail.com` (change later to Mimi's real email) |

3. After adding variables, go to **Deploys** → click **"Trigger deploy"** → **"Deploy site"**

---

## You're Live!

Your site is now at `https://your-site-name.netlify.app`. Test a booking and check that:

- [ ] Services load and you can select them
- [ ] Calendar shows Tue-Sat only
- [ ] Time slots respect the duration needed
- [ ] Booking confirmation appears
- [ ] Mimi gets a notification email at picardjoseph8@gmail.com
- [ ] Client gets a confirmation email

---

## Later: Connect Custom Domain

When you're ready to use Mimi's domain:

1. In Netlify → **Domain management** → **"Add a domain"**
2. Type in the domain name
3. Netlify will give you DNS records to add at your domain registrar
4. Usually takes 5-30 minutes to go live on the custom domain

---

## Folder Structure

```
mimis-studio-site/
  public/
    index.html          ← The booking website (frontend)
  netlify/
    functions/
      get-services.js     ← Loads services from database
      get-available-slots.js  ← Checks real-time availability
      book-appointment.js     ← Books appointment + sends emails
      send-reminders.js       ← Sends 24h and 1h reminders
  netlify.toml          ← Netlify configuration
  package.json          ← Dependencies
  supabase-setup.sql    ← Database schema (run once in Supabase)
  .env.example          ← Template for environment variables
```
