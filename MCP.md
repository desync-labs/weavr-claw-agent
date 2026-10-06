# Add weavr by hand (Claude, ChatGPT, Grok, Gemini, Cursor, …)

This repository is the Claw Agent install. The weavr MCP itself does not need
it. Any host that can attach a **remote** MCP server can talk to weavr with
one URL and no login. Creating a portfolio on those hosts uses the **sign
link**: the agent sends you a page, you sign in a browser wallet, the agent
waits until it is live. The wallet tool, the gate plugin and the curator in
this repo are for a self-hosted Claw Agent; skip them here.

The Claw path, with a wallet on the box, stays in `README.md`.

## The connector

| | |
|---|---|
| URL | `https://mcp.weavr.sh` |
| Same server | `https://api.weavr.sh/mcp` |
| Transport | Streamable HTTP (JSON-RPC `POST`). A `GET` of the URL returns 405; that is expected. |
| Auth | none. Do not pick OAuth, do not add a bearer token, do not invent headers. |
| Discovery | `GET https://api.weavr.sh/.well-known/mcp.json` |

If the host asks how people sign in, choose **No sign in** / **No
authentication**. weavr's MCP is public. A wallet is involved only later, on
the sign page, or through this repo's wallet tool on a Claw Agent.

Generic config, the shape most local hosts take:

```json
{
  "mcpServers": {
    "weavr": {
      "url": "https://mcp.weavr.sh"
    }
  }
}
```

Name the server `weavr`. Enable it in the conversation (a toggle, an
@mention, or a tools menu — hosts differ). Then a thesis is enough.

Vendor menus change without notice; the URL and "no auth" do not. Re-walk the
clicks if a screen has been renamed. Stdio (`npx …`) is the wrong transport:
weavr is remote HTTP only.

## Claude (claude.ai, Claude Desktop, Cowork)

Custom connectors on Free (one), Pro, Max, Team and Enterprise. Claude
reaches the server from Anthropic's cloud, which is fine: weavr is public.

1. Sign in at [claude.ai](https://claude.ai).
2. **Customize → Connectors → Add custom connector.** A prefilled dialog:
   `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=weavr&connectorUrl=https%3A%2F%2Fmcp.weavr.sh`
3. Name `weavr`, URL `https://mcp.weavr.sh`. Continue.
4. Authentication: **No sign in**. Leave request headers empty.
5. Add. In a chat, **+ → Connectors** and enable weavr for that conversation.

Team / Enterprise: an Owner adds it first under **Organization settings →
Connectors → Add → Custom → Web**; members then Connect.

Claude Desktop and Cowork use the same custom connector (still reached from
Anthropic's cloud). A `claude_desktop_config.json` stdio entry is a different
mechanism and will not reach this server.

## ChatGPT

Web only, not the mobile app. Developer mode has to be on.

1. **Settings → Apps → Advanced settings** → turn on **Developer mode**.
   (Business / Enterprise / Edu: an admin enables it first; then the same
   toggle, or **Workspace settings → Apps → Create**.)
2. **Settings → Apps → Create** (admins: **Workspace settings → Apps → Create**).
3. Name `weavr`. Connector URL `https://mcp.weavr.sh`.
4. Authentication: **No authentication**. weavr publishes no OAuth metadata;
   picking OAuth is a dead end.
5. Scan tools, Create. In a new chat, select the weavr app from the tools
   menu (or @mention it). App selection is per message.

Writes (`create_portfolio` and the other money tools) are a Business /
Enterprise / Edu beta. Plus and Pro can attach the server for reads (list,
simulate, status). To create from those plans, use Claude, Grok, Gemini, or a
Claw Agent.

## Grok

1. Open [grok.com/connectors](https://grok.com/connectors).
2. **New Connector → Custom.**
3. Paste `https://mcp.weavr.sh`. There is nothing to sign in to.
4. Chat as usual; Grok uses the tools the same way it uses built-in connectors.

xAI's API takes the same URL as a remote MCP tool (`server_url`,
`server_label: "weavr"`). No `authorization` header. Grok CLI:

```bash
grok mcp add --transport http weavr https://mcp.weavr.sh
```

## Gemini

**Gemini app** (rolling out; Google lists a personal US account, 18+, Keep
Activity on, English). Added on the web, then available on the phone:

1. On a computer, [gemini.google.com](https://gemini.google.com) → **Settings →
   Connected Apps** (sometimes nested under Personal Intelligence).
2. **Custom apps → Add a custom app.**
3. Paste `https://mcp.weavr.sh`. Next. There is no OAuth step.

If Custom apps is missing, the account is outside that rollout; use the CLI.

**Gemini CLI:**

```bash
gemini mcp add --transport http weavr https://mcp.weavr.sh
```

Or in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "weavr": { "url": "https://mcp.weavr.sh" }
  }
}
```

## Cursor and anything else

Paste the same URL as a remote / HTTP / Streamable HTTP MCP server. Typical
places:

| Host | Where |
|---|---|
| Cursor | Settings → MCP, or project `.cursor/mcp.json` (the JSON above) |
| Claude Code | the same custom connector, or a remote entry in MCP settings |
| ChatGPT Codex | Settings → MCP servers → Add server → Streamable HTTP |
| Perplexity | Settings → Connectors → Custom connector → Remote |

## After it is connected

In the chat, in your words:

> My thesis: Bitcoin and Solana. Which assets does weavr offer? Tickers only.

Then a mix, a name, a ticker, a simulation, "create it". On a host with no
wallet tool the agent must pass `wallet: "link"` to `suggest_mix` and
`simulate_portfolio` too (so the mix is not held to the wallet tool's four
assets), call `create_portfolio` with `wallet: "link"` and no creator, send
you the `signUrl` **once in a private chat**, and call `await_portfolio` with
only that deployment id.

The page shows the name, mix, fees and network cost before any wallet prompt.
Whoever connects and signs pays the network cost and is the creator. One
wallet per link; an unclaimed link closes after 30 minutes (`expired`: create
again). Deposits without a wallet tool are made on the portfolio's page on
[weavr.sh](https://www.weavr.sh).

If the agent asks for a wallet address or prints transaction bytes, stop it
and tell it to use the sign link. The same rules are in
`https://api.weavr.sh/llms.txt` and the Claw skill at
`https://api.weavr.sh/hosts/hermes/SKILL.md`.

## What this repo is for

A Claw Agent with PayBox or a local key, so the agent wallet signs on the box
and you approve each money step. That path starts at `README.md`. The
autonomous curator is `curator/README.md`.
