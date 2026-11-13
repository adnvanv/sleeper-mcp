# Setup Guide

How to install the Sleeper MCP server, connect it to Claude Desktop, and run
the web dashboard: on Windows first, then on an Ubuntu home server, so you can
open the dashboard over Tailscale and use the tools from the Claude phone app.

For what the project does and how it works, see [PROJECT.md](PROJECT.md).

---

## 1. Requirements

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 22 or newer | `node --version` |
| npm | comes with Node | `npm --version` |
| git | any recent | `git --version` |
| Claude Desktop | current | only needed for the MCP part |

No Sleeper API key is needed. The Sleeper API is public and read-only.

## 2. Get the code and build it

```bash
git clone https://github.com/adnvanv/sleeper-mcp.git
cd sleeper-mcp
npm install
npm run build
```

`npm run build` compiles TypeScript from `src/` into `dist/`. Run it again
after pulling changes.

## 3. Set your defaults

Copy the example file and fill in your username:

```bash
cp .env.example .env
```

```ini
SLEEPER_USERNAME=your_sleeper_username
# Optional. If you're in exactly one league this season it's found for you.
SLEEPER_LEAGUE_ID=
```

`.env` is gitignored. Real environment variables (for example in the Claude
Desktop config below) take priority over `.env`.

To find a league ID, run:

```bash
npm run smoke -- get_user_leagues '{}'
```

## 4. Check it works

```bash
npm test                                   # builds, then runs all tests
npm run smoke                              # lists tools, prints NFL state
npm run smoke -- get_all_play_records '{}' # calls one tool against live data
```

The unit tests run offline. The protocol tests and `npm run smoke` call the
live Sleeper API.

## 5. Connect Claude Desktop

### Find the config file

Where Claude Desktop keeps `claude_desktop_config.json` depends on how it was
installed:

| Install | Path |
| --- | --- |
| Microsoft Store (MSIX) | `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json` |
| Standard Windows installer | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

Claude Desktop also opens the file for you: **Settings → Developer → Edit
Config**. That's the surest way to get the right one.

### Add the server

Back up the file first. Then add a `sleeper` entry under `mcpServers`,
merging with anything already there. Use absolute paths and double the
backslashes on Windows:

```json
{
  "mcpServers": {
    "sleeper": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\sleeper-mcp\\dist\\index.js"],
      "env": {
        "SLEEPER_USERNAME": "your_sleeper_username",
        "SLEEPER_LEAGUE_ID": "your_league_id"
      }
    }
  }
}
```

- `command` can be just `"node"` if Node is on your PATH. The full path to
  `node.exe` avoids PATH problems.
- `env` is optional if you set up `.env`. The server reads `.env` from the
  repo folder no matter where Claude Desktop starts it.
- Keep every other key in the file (`preferences` and so on) as it is.

### Restart Claude Desktop fully

Closing the window isn't enough. Right-click the Claude icon in the system
tray (bottom-right, near the clock) and choose **Quit**, then reopen it.

In a new chat, the tools menu (the slider icon in the message box) should now
list **sleeper** with 23 tools.

### Try it

- "Who should I pick up this week?"
- "Who's been the luckiest team in my league?"
- "Scout my opponent this week."
- "Find me a trade for a tight end."
- "What moves has my league made since week 7?"

### If the tools don't appear

1. Check the JSON is valid (a missing comma breaks the whole file).
2. Check the path in `args` exists, and that you ran `npm run build`.
3. Read the server log, `mcp-server-sleeper.log`. It's in
   `%LOCALAPPDATA%\Claude-Data\claude_<id>\logs\` for Store installs, or
   `%APPDATA%\Claude\logs\` for the standard installer. Claude Desktop's
   Developer settings also link to it.
4. Claude Desktop rewrites its config while running. If your edit vanished,
   quit Claude Desktop first, edit, then reopen.

## 6. Run the dashboard

```bash
npm run dashboard
```

Then open **http://localhost:3030**. The command builds first, then starts
the server. Stop it with `Ctrl+C`.

The dashboard needs `SLEEPER_USERNAME` (from `.env` or the environment). It
shows:

- **This week**: every matchup with live scores and how many starters have
  yet to play. Yours is pinned and highlighted.
- **My roster**: starters, bench, IR and taxi, with injury and bye badges, this
  week's points, season points per game, and warnings for an empty, injured or
  bye-week starter.
- **Standings**: actual record next to the all-play record, luck, and points
  for. Click a column header to sort.
- **Trending free agents**: the most-added players nobody in your league has.
- **Recent moves**: trades, waiver claims (with FAAB bids) and free-agent
  moves from the last three weeks, with filters.

It refreshes every 2 minutes during NFL game windows (Thursday night, Sunday,
Monday night, and Saturdays from mid-December) and every 15 minutes otherwise.
There's also a Refresh button. The **Theme** button switches between auto,
light and dark.

### Change the port or host

```bash
# Windows PowerShell
$env:DASHBOARD_PORT = "8080"; npm run dashboard

# macOS / Linux
DASHBOARD_PORT=8080 npm run dashboard
```

Or set `DASHBOARD_HOST` / `DASHBOARD_PORT` in `.env`. The default host,
`127.0.0.1`, only accepts connections from the same computer. Use `0.0.0.0` to
reach it from other devices on your network.

## 7. Run the dashboard on an Ubuntu home server

### Install

```bash
# Node 22 LTS from NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/adnvanv/sleeper-mcp.git ~/sleeper-mcp
cd ~/sleeper-mcp
npm install
npm run build
cp .env.example .env
nano .env   # set SLEEPER_USERNAME, SLEEPER_LEAGUE_ID, DASHBOARD_HOST=0.0.0.0
```

### Keep it running with systemd

Run it as a **user service** (no `sudo` needed to restart it). Create
`~/.config/systemd/user/sleeper-dashboard.service`:

```ini
[Unit]
Description=Sleeper fantasy dashboard
After=network-online.target

[Service]
WorkingDirectory=%h/sleeper-mcp
ExecStart=/usr/bin/node dist/dashboard/server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now sleeper-dashboard
sudo loginctl enable-linger $USER          # keep it running when you're logged out
systemctl --user status sleeper-dashboard  # should say "active (running)"
journalctl --user -u sleeper-dashboard -f  # live logs
```

The service runs `dist/` directly, so after `git pull`, run `npm run build` and
`systemctl --user restart sleeper-dashboard`.

(A system-wide service in `/etc/systemd/system/` with `User=youruser` and
`WantedBy=multi-user.target` works too; then every command needs `sudo` and
no `--user`.)

### Optional: AI article reader

Add `GEMINI_API_KEY=<key from aistudio.google.com>` to `.env` and restart the
service. Gemini then reads your players' news and writes a short take on
each; see PROJECT.md. The key stays in `.env`, which git ignores.

### Open it from your phone

**At home on Wi-Fi:** find the server's address with `hostname -I` (for
example `192.168.1.50`) and open `http://192.168.1.50:3030` on your phone. If
the firewall is on, run `sudo ufw allow from 192.168.0.0/16 to any port 3030`.

**Anywhere, over Tailscale (recommended):** with Tailscale on both the server
and your phone, open `http://<server-name>:3030`. Use the machine name shown in
the Tailscale app, or its `100.x.x.x` address. To allow only Tailscale devices
through the firewall:

```bash
sudo ufw allow in on tailscale0 to any port 3030
```

Don't forward the port on your router. The dashboard has no login, so keep it
on your home network or Tailscale.

### Install it as an app on your iPhone

iPhones only install web apps from HTTPS addresses. Tailscale can give the
dashboard one that stays private to your own devices:

1. **Once, on the server:** let your user manage Tailscale, then serve the
   dashboard over HTTPS on port 8443 (use the address the dashboard listens
   on, `DASHBOARD_HOST:DASHBOARD_PORT`):

   ```bash
   sudo tailscale set --operator=$USER
   tailscale serve --bg --https=8443 http://<DASHBOARD_HOST>:3030
   tailscale serve status    # shows https://<server>.<tailnet>.ts.net:8443 (tailnet only)
   ```

   This is `serve`, not `funnel`: only devices on your Tailscale network can
   open it. It doesn't change a Funnel you set up for the MCP endpoint.
2. **On the iPhone:** with the Tailscale app connected, open
   `https://<server>.<tailnet>.ts.net:8443` in **Safari**, tap **Share**, then
   **Add to Home Screen**, then **Add**.

It opens full screen from its own icon. Tailscale has to be connected on the
phone for it to load. To stop serving: `tailscale serve --https=8443 off`.

## 8. Use the tools from Claude on your phone

Claude Desktop starts the MCP server itself, on your computer. The Claude phone
app can't do that. It uses **custom connectors**, which are MCP servers on the
web that Claude connects to from Anthropic's servers. So the phone setup needs:

1. The server's **HTTP mode** (`npm run mcp:http`) running on your Ubuntu box.
2. A **public HTTPS address** for it. Tailscale Funnel gives you one without
   opening router ports. (Tailscale alone isn't enough: Claude's servers
   aren't on your tailnet.)
3. The address added as a **custom connector** at claude.ai. Connectors you
   add there also appear in the phone app.

Only the MCP endpoint goes public. The dashboard stays private on Tailscale.

### Step 1: Set a secret and start HTTP mode

The endpoint only answers at `/mcp/<secret>`. Every other address returns
"not found", so nobody can use it without the secret. Run once to get a fresh
secret:

```bash
cd ~/sleeper-mcp
npm run mcp:http
```

It stops and prints a line like `MCP_HTTP_SECRET=Xy3…`. Add that line to
`.env`, which should now contain:

```ini
SLEEPER_USERNAME=your_sleeper_username
SLEEPER_LEAGUE_ID=your_league_id
MCP_HTTP_SECRET=<the printed value>
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3031
```

Keep `MCP_HTTP_HOST=127.0.0.1`: Funnel connects locally, so nothing else needs
to reach this port. Treat the secret like a password. It's in `.env`, which git
ignores, and never goes in the repo.

Run it as a service, like the dashboard. Create
`/etc/systemd/system/sleeper-mcp-http.service`:

```ini
[Unit]
Description=Sleeper MCP (HTTP) for Claude connectors
After=network-online.target
Wants=network-online.target

[Service]
User=youruser
WorkingDirectory=/home/youruser/sleeper-mcp
ExecStart=/usr/bin/node dist/http-server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sleeper-mcp-http
curl http://127.0.0.1:3031/health        # {"ok":true}
```

### Step 2: Publish it with Tailscale Funnel

```bash
sudo tailscale funnel --bg 3031
tailscale funnel status
```

The first time, Tailscale may print a link to turn on HTTPS certificates and
Funnel for your tailnet in the admin console. Approve it and run the command
again. The status output shows your public address, for example
`https://myserver.tail1234.ts.net`. Funnel forwards it to port 3031 on the
server and handles the HTTPS certificate.

Your connector URL is that address plus the secret path:

```
https://myserver.tail1234.ts.net/mcp/<MCP_HTTP_SECRET>
```

Test it from any computer with the repo:

```bash
npm run smoke -- --url "https://myserver.tail1234.ts.net/mcp/<secret>"
```

It should list 23 tools and print the NFL state. Funnel settings survive
reboots. To take the endpoint offline: `sudo tailscale funnel reset`.

### Step 3: Add the connector in Claude

1. On claude.ai (web), open **Settings → Connectors** and choose **Add custom
   connector**. Custom connectors may depend on your Claude plan.
2. Name it `Sleeper` and paste the full URL from step 2, including the secret.
   Leave the authentication / OAuth fields empty.
3. In the phone app, start a chat, open the tools menu, and turn **Sleeper**
   on.

Then ask "who should I pick up this week?" from your phone.

### Security notes

- Everything is read-only, and the data is public Sleeper data. The worst
  case for a leaked secret is someone else using your server's Sleeper API
  calls.
- If the secret leaks, change `MCP_HTTP_SECRET` in `.env`, run
  `sudo systemctl restart sleeper-mcp-http`, and update the connector URL.
- Only `/mcp/<secret>` and `/health` respond. The dashboard is a separate
  process on a separate port and is not public.

## 9. Updating

```bash
git pull
npm install
npm run build
```

Then restart whatever you run: Claude Desktop (fully, from the tray), and on the server
`systemctl --user restart sleeper-dashboard sleeper-mcp-http` (or with
`sudo` and no `--user` if you installed them system-wide).

## 10. Housekeeping

- The player database (about 19 MB) is cached in `.cache/` and refreshed once
  a day, as Sleeper asks. The NFL schedule is cached there too. Deleting
  `.cache/` is always safe.
- The `clear_cache` tool (ask Claude to "clear the player cache") forces a
  fresh download.
- Everything is read-only. Nothing here can change your team.
