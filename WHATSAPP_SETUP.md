# WhatsApp Business + Photon/Spectrum Setup (Phase 0)

> **This is the #1 bottleneck** — Meta approval takes 2–10 business days. Start **today**.

---

## 1. Prerequisites (you need these accounts)

| Service | Purpose | Link |
|---------|---------|------|
| **Meta Business Manager** | WhatsApp Business Account (WABA) | https://business.facebook.com |
| **Meta for Developers** | Cloud API app + credentials | https://developers.facebook.com |
| **Photon/Spectrum** | Always-on webhook host (handles Meta webhook verification, retries, scaling) | https://photon.dev (or your internal Spectrum instance) |
| **Public HTTPS endpoint** | For Photon to POST webhooks to (if self-hosting fallback) | Cloud Run, Cloudflare Tunnel, ngrok (dev only) |

---

## 2. Create WhatsApp Business Account (WABA)

1. In **Meta Business Manager** → **Accounts** → **WhatsApp Accounts** → **Add** → **Create new WABA**
2. Verify business (may require docs). Pick a display name (e.g., "Boss PA").
3. Note the **WABA ID** (looks like `123456789012345`).

---

## 3. Create Meta Cloud API App

1. Go to **Meta for Developers** → **My Apps** → **Create App** → **Business** → **WhatsApp**.
2. App name: "Boss PA Agent".
3. In **WhatsApp** → **Getting Started**:
   - **Phone Number ID** (e.g., `123456789012345`) — copy this → `WHATSAPP_PHONE_NUMBER_ID`
   - **Access Token** (temporary, 24h) — copy → `WHATSAPP_ACCESS_TOKEN`
   - Later: generate a **permanent token** (System User → Token with `whatsapp_business_messaging`).
4. **App Secret** → **Settings** → **Basic** → **Show** → copy → `WHATSAPP_APP_SECRET`
5. **Webhook** → **Configure**:
   - Callback URL: `https://YOUR_PHOTON_HOST/webhook/photon` (Photon handles this)
   - Verify Token: generate a random string → `PHOTON_WEBHOOK_SECRET`
   - Subscribe to `messages` field.
6. **Add phone number** to the app (in WhatsApp → Configuration). This is the number the PA will text.

---

## 4. Photon / Spectrum Project

### Option A: Photon-hosted (recommended for hackathon)
1. Sign up at https://photon.dev (or use your team's Spectrum instance).
2. Create a **Project** → note `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`.
3. In Project settings → **Providers** → Add **WhatsApp Business** → paste Meta credentials:
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_APP_SECRET`
4. Photon gives you a **Project ID/Secret** — these go in `.env` as `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET`.

### Option B: Self-hosted webhook (fallback)
If you skip Photon, run `src/server.js` on a public HTTPS endpoint:
- Set `CHANNEL_PROVIDER=whatsapp-business`
- Set Meta creds directly (`WA_*` vars)
- `PHOTON_SEND_URL=https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>/messages`
- `PHOTON_SEND_TOKEN=<permanent_access_token>`
- `PHOTON_WEBHOOK_SECRET=<your_verify_token>`
- `PHOTON_AGENT_PHONE=<your_whatsapp_number_with_country_code>`

---

## 5. Environment Variables (`.env`)

```bash
# Channel
CHANNEL_PROVIDER=whatsapp-business
SPECTRUM_PROJECT_ID=proj_abc123
SPECTRUM_PROJECT_SECRET=sec_xyz789
PA_DRY=0

# Meta Cloud API (from step 3)
WHATSAPP_ACCESS_TOKEN=EAA...        # permanent system-user token
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_APP_SECRET=abcdef123456

# Photon webhook (if self-hosting fallback)
PHOTON_WEBHOOK_SECRET=random_verify_token
PHOTON_SEND_TOKEN=EAA...            # same as access token
PHOTON_SEND_URL=https://graph.facebook.com/v20.0/123456789012345/messages
PHOTON_AGENT_PHONE=15551234567      # E.164 format

# Google Workspace (for Calendar/Gmail — §0 fork)
GOOGLE_SA_KEY_PATH=./sa-key.json
BOSS_CALENDAR_EMAIL=boss@company.com
BOSS_TIMEZONE=America/New_York
```

---

## 6. Verify End-to-End (run this after credentials are in `.env`)

```bash
# 1. Syntax check
node --check src/channel.js

# 2. Dry-run sanity (PA_DRY=1 uses stdin, no network)
PA_DRY=1 node src/channel.js
# Type: "flights JFK to LHR Friday" → should show options

# 3. Live channel connect (PA_DRY=0, needs Photon project)
PA_DRY=0 node src/channel.js
# Should print: "🧑‍💼 BOSS PA online via whatsapp-business (project proj_ab…)."

# 4. Send a test message from the PA's WhatsApp to your Business number
# Agent should reply in-thread.
```

---

## 7. Checklist (tick each before hackathon)

- [ ] WABA created + business verified
- [ ] Meta Cloud API app created + permanent access token generated
- [ ] Phone number added to app + 2FA off (for testing)
- [ ] Webhook URL configured in Meta (points to Photon or your server)
- [ ] Photon project created + WhatsApp provider configured
- [ ] `.env` populated with all `SPECTRUM_*` / `WHATSAPP_*` vars
- [ ] `PA_DRY=0 node src/channel.js` connects without error
- [ ] PA sends "hi" → agent replies
- [ ] PA sends "flights JFK to LHR Friday" → options appear
- [ ] PA sends "book f1" → confirmation + itinerary entry

---

## 8. Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` on send | Token expired / wrong phone ID | Regenerate permanent system-user token |
| Webhook verification fails | `PHOTON_WEBHOOK_SECRET` mismatch | Ensure same string in Meta + `.env` |
| "Number not registered" | Phone not added to Cloud API app | WhatsApp → Configuration → Add number |
| Photon "provider not found" | `CHANNEL_PROVIDER` typo | Must be exactly `whatsapp-business` |
| No reply on PA's phone | Outbound send URL/token wrong | Check `PHOTON_SEND_URL` includes correct version + phone ID |

---

## 9. Google Workspace Fork (Calendar/Gmail)

Once WhatsApp is live, confirm §0: **Google Workspace or Outlook?**

- **Google** (default): Add service account JSON → `GOOGLE_SA_KEY_PATH`, enable Calendar + Gmail APIs, delegate domain-wide authority to SA.
- **Outlook**: Swap `calendar.js` / `email.js` providers to Microsoft Graph (same interface, different auth).

The rest of the agent is unchanged.

---

## 10. Demo-Day Fallback

Even with Photon, have the CLI mock ready:
```bash
PA_DRY=1 node src/channel.js
```
Runs the full agent loop over stdin — perfect for screen-recording the demo video if WhatsApp flakes.