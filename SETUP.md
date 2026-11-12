# Setup Guide

How to install the Sleeper MCP server, connect it to Claude Desktop, and run
the web dashboard: on Windows first, then on an Ubuntu home server so you can
open the dashboard from your phone.

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
npm test                                   # builds, then 82 tests
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

Create `/etc/systemd/system/sleeper-dashboard.service`, replacing `youruser`:

```ini
[Unit]
Description=Sleeper fantasy dashboard
After=network-online.target
Wants=network-online.target

[Service]
User=youruser
WorkingDirectory=/home/youruser/sleeper-mcp
ExecStart=/usr/bin/node dist/dashboard/server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sleeper-dashboard
systemctl status sleeper-dashboard       # should say "active (running)"
journalctl -u sleeper-dashboard -f       # live logs
```

The service runs `dist/` directly, so after `git pull`, run `npm run build` and
`sudo systemctl restart sleeper-dashboard`.

### Open it from your phone

1. Find the server's address: `hostname -I` (for example `192.168.1.50`).
2. If the firewall is on: `sudo ufw allow from 192.168.0.0/16 to any port 3030`.
3. On your phone, on the same Wi-Fi, open `http://192.168.1.50:3030`.

To reach it away from home, put it behind a private VPN such as Tailscale or
WireGuard rather than forwarding the port on your router. The dashboard has no
login. It only shows public league data, but there's no reason to expose it to
the internet.

## 8. Updating

```bash
git pull
npm install
npm run build
```

Then restart Claude Desktop (fully, from the tray) and/or the dashboard.

## 9. Housekeeping

- The player database (about 19 MB) is cached in `.cache/` and refreshed once
  a day, as Sleeper asks. The NFL schedule is cached there too. Deleting
  `.cache/` is always safe.
- The `clear_cache` tool (ask Claude to "clear the player cache") forces a
  fresh download.
- Everything is read-only. Nothing here can change your team.
