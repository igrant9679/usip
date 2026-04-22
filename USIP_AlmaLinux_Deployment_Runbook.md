# USIP — AlmaLinux Deployment Runbook

**For:** Idris Grant · LSI Media LLC
**Target host:** AlmaLinux server (assumes 9.x; works on 8.x with minor package name differences)
**Domain:** `usip.lsi-media.com` (adjust throughout if yours differs)
**App file:** `usip.html` (the single-file app you've been building)

---

## What you're actually standing up

- A single static HTML file served by Nginx behind HTTPS
- Protected by HTTP Basic Auth (or swap in `oauth2-proxy` later — notes at the end)
- A tiny Node.js relay that proxies USIP's "Send" calls to SendGrid (because SendGrid blocks browser-origin calls)
- That's it. No database, no build step, no Docker. The whole thing is two services: Nginx and one Node process.

Time to complete if nothing goes sideways: **30–45 minutes.**

---

## 0. Prerequisites

**On your laptop:**
- The `usip.html` file
- SSH access to the AlmaLinux server as a user with sudo
- A SendGrid API key (full access, or Mail Send + Sender Verification scopes minimum)
- Your Anthropic or OpenAI API key (for the in-app AI features)

**On the server:**
- Root/sudo access
- Port 80 and 443 open in the firewall to the internet
- A DNS A record pointing `usip.lsi-media.com` → your server's public IP (do this first; DNS propagation takes 5–30 minutes)

**Verify DNS before continuing:**
```bash
dig +short usip.lsi-media.com
# Should print your server's IP. If blank, wait and re-check.
```

---

## 1. Install core packages

SSH to the server, then:

```bash
sudo dnf install -y epel-release
sudo dnf install -y nginx certbot python3-certbot-nginx httpd-tools nodejs git
# AlmaLinux 9 ships Node 18+; if you get an older version, use nodesource:
#   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
#   sudo dnf install -y nodejs
node -v   # confirm 18+ ideally 20+
```

Enable services to start on boot:

```bash
sudo systemctl enable --now nginx
```

---

## 2. Create the app directory and upload the HTML

On the server:

```bash
sudo mkdir -p /var/www/usip
sudo chown -R $USER:$USER /var/www/usip
```

From your laptop:

```bash
scp usip.html idris@usip.lsi-media.com:/var/www/usip/index.html
```

Fix ownership and permissions (Nginx on RHEL-family runs as `nginx`):

```bash
sudo chown -R nginx:nginx /var/www/usip
sudo chmod -R 644 /var/www/usip/index.html
sudo chmod 755 /var/www/usip
```

**If SELinux is enforcing** (it usually is on AlmaLinux), you need to tell it Nginx is allowed to serve from `/var/www/usip`:

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/var/www/usip(/.*)?"
sudo restorecon -Rv /var/www/usip
```

If `semanage` isn't installed: `sudo dnf install -y policycoreutils-python-utils`

---

## 3. Create the Basic Auth credentials

```bash
sudo htpasswd -c /etc/nginx/.usip-htpasswd idris
# Enter password twice when prompted
```

To add more team members later (drop the `-c` flag, which would overwrite):

```bash
sudo htpasswd /etc/nginx/.usip-htpasswd priya
```

Lock down the file:

```bash
sudo chmod 640 /etc/nginx/.usip-htpasswd
sudo chown root:nginx /etc/nginx/.usip-htpasswd
```

---

## 4. Nginx vhost config (HTTP only for now — Certbot will rewrite it)

Create `/etc/nginx/conf.d/usip.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name usip.lsi-media.com;

    root /var/www/usip;
    index index.html;

    # Basic auth across the whole app
    auth_basic           "USIP · LSI Media";
    auth_basic_user_file /etc/nginx/.usip-htpasswd;

    # Relay endpoint for the SendGrid proxy (no basic-auth here — the app is behind auth)
    # The relay enforces its own header secret (see Section 6)
    location /api/ {
        auth_basic off;   # Browser can't send basic-auth on fetch() without CORS prep
        proxy_pass http://127.0.0.1:3088;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 5m;
    }

    location / {
        try_files $uri $uri/ =404;
    }

    # Browsers cache aggressively — always revalidate the HTML
    location = /index.html {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # Basic security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";
}
```

Test and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

At this point browsing to `http://usip.lsi-media.com/` should prompt for basic auth and serve the app.

---

## 5. Get an HTTPS certificate

```bash
sudo certbot --nginx -d usip.lsi-media.com --agree-tos --email idris@lsi-media.com --redirect --non-interactive
```

Certbot edits the vhost config in place to add port 443 and a redirect from port 80. Verify:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -I https://usip.lsi-media.com/   # Should return 401 (basic auth required) over HTTPS
```

Auto-renew is set up automatically via systemd timer:

```bash
systemctl list-timers | grep certbot
```

---

## 6. The SendGrid relay

Create a service user and directory:

```bash
sudo useradd -r -s /bin/false -d /opt/usip-relay usip-relay || true
sudo mkdir -p /opt/usip-relay
cd /opt/usip-relay
```

Create `package.json`:

```json
{
  "name": "usip-relay",
  "version": "1.0.0",
  "private": true,
  "main": "relay.js",
  "dependencies": {
    "express": "^4.19.2",
    "node-fetch": "^2.7.0"
  }
}
```

Create `relay.js`:

```javascript
// /opt/usip-relay/relay.js
// Proxies USIP's Send requests through to SendGrid, keeps the API key server-side.
const express = require('express');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3088;
const KEY  = process.env.SENDGRID_KEY;
const SEC  = process.env.USIP_RELAY_SECRET;

if (!KEY) { console.error('SENDGRID_KEY not set'); process.exit(1); }
if (!SEC) { console.error('USIP_RELAY_SECRET not set'); process.exit(1); }

app.use(express.json({ limit: '2mb' }));

// Same-origin check: the relay is behind Nginx on usip.lsi-media.com,
// which is itself behind basic auth. Additionally require a shared secret
// header so random traffic hitting /api/* can't relay through SendGrid.
app.use((req, res, next) => {
  if (req.get('X-USIP-Secret') !== SEC) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// Health check
app.get('/api/ping', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// Send via SendGrid
app.post('/api/send', async (req, res) => {
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(req.body),
    });
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'text/plain').send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SendGrid account probe (used by the Test connection button)
app.get('/api/sendgrid-account', async (req, res) => {
  try {
    const r = await fetch('https://api.sendgrid.com/v3/user/account', {
      headers: { 'Authorization': 'Bearer ' + KEY },
    });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => console.log('USIP relay on 127.0.0.1:' + PORT));
```

Install dependencies:

```bash
cd /opt/usip-relay
npm install
```

Generate a secret for the relay and save it:

```bash
openssl rand -hex 32
# Copy this value — you'll use it in TWO places: the systemd EnvironmentFile and the USIP app itself
```

Create `/etc/usip-relay.env` (owner: root, mode 600):

```bash
sudo tee /etc/usip-relay.env >/dev/null <<EOF
SENDGRID_KEY=SG.paste-your-sendgrid-key-here
USIP_RELAY_SECRET=paste-the-openssl-output-here
PORT=3088
EOF
sudo chown root:root /etc/usip-relay.env
sudo chmod 600 /etc/usip-relay.env
sudo chown -R usip-relay:usip-relay /opt/usip-relay
```

Create the systemd unit at `/etc/systemd/system/usip-relay.service`:

```ini
[Unit]
Description=USIP SendGrid relay
After=network.target

[Service]
Type=simple
User=usip-relay
WorkingDirectory=/opt/usip-relay
EnvironmentFile=/etc/usip-relay.env
ExecStart=/usr/bin/node relay.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/usip-relay

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now usip-relay
sudo systemctl status usip-relay   # should be active (running)
```

**Smoke test the relay from the server:**

```bash
curl -s http://127.0.0.1:3088/api/ping -H "X-USIP-Secret: $(sudo grep USIP_RELAY_SECRET /etc/usip-relay.env | cut -d= -f2)"
# Should return: {"ok":true,"at":"..."}
```

**Smoke test through Nginx from your laptop:**

```bash
curl -s https://usip.lsi-media.com/api/ping -H "X-USIP-Secret: YOUR_SECRET"
# Same JSON response
```

---

## 7. Wire the relay URL into USIP

USIP currently calls SendGrid directly from the browser and expects the CORS wall — that's been the pattern during development. To route through your relay instead, you need a tiny edit to `index.html` on the server. This is a single-function change:

```bash
sudo vi /var/www/usip/index.html
```

Search for `api.sendgrid.com/v3/user/account` — there's exactly one occurrence in the Settings → Sending infra "Test connection" handler. You'll also want to add a helper that actually uses the relay for sends. Paste-ready diff instructions:

**Find** (around the Test connection button in the Settings sending tab):

```javascript
const r = await fetch('https://api.sendgrid.com/v3/user/account', {
  headers: {'Authorization': 'Bearer ' + sg.apiKey},
});
```

**Replace with:**

```javascript
const r = await fetch('/api/sendgrid-account', {
  headers: {'X-USIP-Secret': sg.relaySecret || ''},
});
```

Then, right after the existing SendGrid API key field in the same `renderSettingsSending` SendGrid branch, add a relay-secret field. Search for `state.sendingInfra.sendgrid.apiKey = e.target.value.trim()` and add, right after the form-row it's wrapped in, a second form-row:

```javascript
el('div', {class:'form-row'},
  el('label', {class:'form-label'}, 'Relay secret'),
  el('div', {class:'input-icon'},
    el('span', {class:'ico', html:icon('key',13)}),
    el('input', {class:'input', type:'password', placeholder:'paste X-USIP-Secret value', value: sg.relaySecret || '',
      oninput: e => { state.sendingInfra.sendgrid.relaySecret = e.target.value.trim(); saveState(); }})
  ),
  el('div', {class:'form-hint'}, 'The shared secret from /etc/usip-relay.env on your server. Required to route sends through the relay.')
),
```

Save the file. No restart needed — static files update immediately. Hard-reload USIP in your browser (Cmd+Shift+R).

**Now test sending from USIP:**

1. Open `https://usip.lsi-media.com/` → authenticate with basic auth
2. Settings → AI provider → paste your Anthropic key, click "Test connection" — should succeed
3. Settings → Sending infra → SendGrid tab → paste your SendGrid key AND the relay secret → click Test connection — this time it hits the relay, not SendGrid directly, and succeeds (no more CORS error)
4. Settings → Email senders → verify at least one identity (or add one) and mark it verified after confirming in the SendGrid console

You now have a working deployment.

---

## 8. Smoke tests — what "working" looks like

After the whole stack is up, walk through this checklist. Each step exercises a different layer.

- [ ] `https://usip.lsi-media.com/` prompts for basic auth, then loads the dashboard
- [ ] Sidebar nav all works (Dashboard, Prospects, Pipeline, Sequences, Inbox, Signals, Lead Scoring, AI Research, Reports, Team, Settings)
- [ ] Settings → AI provider → Test connection returns `USIP connection OK`
- [ ] Settings → Sending infra → SendGrid → Test connection returns your account info (relay working)
- [ ] Settings → Domain auth → enter `lsi-media.com` / `s1` → Check DNS returns real records from dns.google (no backend involved)
- [ ] AI Research → pick any prospect → Run full pipeline → stage bar completes, three variants render, Approve one, it appears in the Approval queue
- [ ] Prospects table shows tier badges (Cold/Warm/Hot/Sales Ready) with computed scores
- [ ] Click a high-scoring prospect → green "Sales Ready" banner at top of drawer → "Pick sequence" opens the sequence picker
- [ ] Pipeline → click a deal card → War Room opens → Buying Committee is editable (role dropdown, status click-to-cycle, add/remove)
- [ ] Sequence detail → Enroll prospects → modal filters by tier, selection works, enrollments persist on reload

If all of those pass, you're green.

---

## 9. Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| 403 when loading the app | SELinux blocking Nginx from reading files | `sudo restorecon -Rv /var/www/usip` |
| 502 on `/api/*` | Relay not running | `sudo systemctl status usip-relay` then `journalctl -u usip-relay -n 100` |
| 401 from the relay | Missing or wrong `X-USIP-Secret` header | Verify secret in USIP Settings matches `/etc/usip-relay.env` |
| Test connection returns the generic CORS error | Browser cached the old HTML | Hard reload (Cmd+Shift+R) and verify the edit in Section 7 landed |
| Certbot fails | DNS not propagated, or port 80 blocked | `dig +short usip.lsi-media.com` and check firewall/cloud security group for port 80 open |
| `nginx: [emerg] cannot load user file` | Typo or permission on htpasswd | `ls -la /etc/nginx/.usip-htpasswd` — owner root:nginx, mode 640 |
| AI features say "no API key" | Key saved in localStorage for the wrong browser profile | Re-enter in Settings → AI provider on each browser you use |
| Claude API returns CORS error | The `anthropic-dangerous-direct-browser-access` header is correctly set but the origin is wrong | This only works from pages with a real origin (https://...). Won't work opening the HTML as a local file. |

**Useful log commands:**

```bash
sudo journalctl -u usip-relay -f          # live relay logs
sudo tail -f /var/log/nginx/access.log    # Nginx access
sudo tail -f /var/log/nginx/error.log     # Nginx errors
```

---

## 10. Security checklist before you let anyone else use it

- [ ] Basic auth password is strong (16+ chars, unique)
- [ ] Separate basic-auth user per team member — don't share credentials
- [ ] `/etc/usip-relay.env` is mode 600, owner root
- [ ] SendGrid API key is scoped to Mail Send + Sender Verification (not full access) if possible
- [ ] SELinux is enforcing (`getenforce` returns `Enforcing`)
- [ ] `firewalld` allows only 22/80/443 from the internet; everything else blocked
- [ ] SSH uses keys, not passwords (`PasswordAuthentication no` in `/etc/ssh/sshd_config`)
- [ ] Auto-updates for security patches: `sudo dnf install -y dnf-automatic && sudo systemctl enable --now dnf-automatic.timer`
- [ ] A scheduled `certbot renew` is in place (`systemctl list-timers | grep certbot`)
- [ ] Nightly backup of `/var/www/usip/` and `/etc/usip-relay.env` to somewhere off-box (a client's USIP state lives in localStorage in their browser — not on disk — but your config files do live here)

---

## 11. Upgrade flow (how to push new versions of USIP)

When I send you a new `usip.html`:

```bash
# 1. Back up what's running
sudo cp /var/www/usip/index.html /var/www/usip/index.html.bak-$(date +%Y%m%d)

# 2. Push new version
scp usip.html idris@usip.lsi-media.com:/tmp/usip-new.html
sudo mv /tmp/usip-new.html /var/www/usip/index.html
sudo chown nginx:nginx /var/www/usip/index.html
sudo chmod 644 /var/www/usip/index.html
sudo restorecon -v /var/www/usip/index.html

# 3. Re-apply the Section 7 relay edit if the upgrade touches the SendGrid code
#    (I'll call this out explicitly in the release notes if it does)

# 4. Hard-reload in the browser
```

The app's state lives in each user's browser `localStorage` under key `usip-state-v3`. It survives file upgrades. If I bump the storage version (which will be called out), users will silently re-seed.

---

## 12. Things deliberately not included, and why

- **Docker.** Not worth it for a single HTML file plus a 50-line Node relay. Plain systemd units are simpler to reason about.
- **Shared state / multi-user sync.** Currently each user has their own localStorage. Two people editing the same deal see different truth. Fixing this requires a real backend — a meaningful engineering effort, not a deployment task.
- **`oauth2-proxy` instead of basic auth.** Worth upgrading to once you have 5+ users or need Google SSO. The Nginx vhost in Section 4 already sets up the shape; swap the `auth_basic` directives for `auth_request /oauth2/auth`. Happy to write that runbook separately.
- **A staging environment.** Single-file static apps don't really benefit from one. If you want safety, keep a `/var/www/usip/index-prev.html` around and flip with a symlink.
- **Monitoring / uptime checks.** For a 2-service deployment, a Healthchecks.io hit from a cron hitting `https://usip.lsi-media.com/api/ping` every 5 minutes is sufficient and free.

---

## 13. What to tell me after a week of use

Once you've used it day-to-day, the honest-to-useful feedback I most want:

1. Which views do you open most? Which do you never open?
2. What does the Priority Queue on the dashboard get wrong? Too many items, wrong order, missing something?
3. When a prospect replies, what's the first thing you want to do? Does the inbox make that easy?
4. Does the sequence builder feel like enough step types, or are you working around a missing one?
5. What does the Scoring tier threshold get wrong for your actual leads?
6. Is the AI Personality producing drafts that sound like you, or do you rewrite every draft?
7. What did you want to build/configure/change that you couldn't?

That's the feedback loop that tells us where to put the next 1,000 lines. Until then, I'm guessing and you know it.

---

*Drafted by Claude for LSI Media · keep this file in your Ops folder alongside the USIP source.*
