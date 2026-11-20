# Coach Journal — private single-user workspace

Tablet-first Training Canvas, styled as a refined ivory-and-gold coach journal.

## Deploy on Railway

The application uses a Node.js server (Railpack), with PostgreSQL for persistent storage.

1. Keep the service connected to `tudorphysio/ClientLog`, branch `feature/flexible-training-cards`, root directory `/training-canvas`, builder **Railpack**.
2. In the same Railway project, add **PostgreSQL**.
3. In the Training Canvas service **Variables**, configure:
   - `DATABASE_URL` = **reference variable** to PostgreSQL's `DATABASE_URL`, typically `${{Postgres.DATABASE_URL}}` (select it using Railway's variable picker).
   - `APP_PASSWORD` = your own new, strong password (minimum 12 characters).
   - `SESSION_SECRET` = a long random secret (minimum 32 characters; never commit it).
   - `INTEGRATION_TOKEN` = optional future integration secret (minimum 32 random characters, if enabled).
4. Deploy and open the previously generated domain. It should display a password screen. Log in with `APP_PASSWORD`.
5. Use **+ Profile** for a separate client workspace. Cards sync to PostgreSQL for tablet/computer access.

**Never put actual passwords, credentials, API tokens or client records into GitHub.**
If the database/secret variables aren't configured, the server deliberately refuses to start to avoid pretending to persist data.

## API for future direct updates

All routes except `/health` and `/login` require authentication. Browser session is an HttpOnly cookie, and server-to-server integrations can use `Authorization: Bearer <INTEGRATION_TOKEN>`. That token must never be placed in client-side JavaScript or a public link.

- `GET /api/workspaces` — list profiles
- `POST /api/workspaces` — create profile: `{"id":"majed","name":"Majed"}`
- `GET /api/workspaces/majed` — retrieve journal
- `PUT /api/workspaces/majed` — replace full canvas snapshot
- `POST /api/workspaces/majed/cards` — add note without replacing existing cards: `{"title":"Training 20 Nov","date":"2026-11-20","type":"training","note":"..." }`

The API is now implemented, **but ChatGPT isn't automatically connected to arbitrary external websites**. To make conversational updates directly through ChatGPT, register a supported custom connector/plugin that securely calls this API (or provide a supported tool integration). The API exists to support that connection. Do not paste your password/token into this chat.

## Previous browser-local data

Previous versions stored journals in the browser's localStorage. This version does not silently upload those notes. Use an older version to export JSON, then use **Import** on the new cloud profile after deployment. Import replaces the currently selected profile's canvas, so make a backup first.

## Security and limitations

This is a single-owner prototype, not a clinical electronic medical-record system or a multi-user access-controlled product. Avoid storing patient diagnoses, sensitive medical data or identifying health records until privacy, access controls, backups, compliance and retention are reviewed.

- Shared-password sign-in; no password reset interface.
- Data stored in Railway Postgres, not local browser storage. Keep database backups.
- API card insertion is supported; real-time multi-device editing/merge, access auditing and fine-grained permissions are not yet implemented.
- This is not automatically deployed to your Railway service simply by writing to GitHub; configure Railway variables and deploy.

## Direct ChatGPT MCP connection (OAuth)

The deployed service now includes:
- HTTPS MCP endpoint: `https://clientlog-production-8c3920e3.up.railway.app/mcp`
- OAuth authorization discovery and short-lived access/refresh tokens, with PKCE and dynamic client registration.
- Four tools: `list_training_profiles`, `read_training_profile`, `create_training_profile`, `add_training_card`.
- Authenticated access only. ChatGPT will prompt for the existing `APP_PASSWORD` during the OAuth permission step; never put it in chat, GitHub, or a public URL.

In ChatGPT Plugins > + > Add custom MCP server:
1. Name: **Coach Journal**
2. Server URL: `https://clientlog-production-8c3920e3.up.railway.app/mcp`
3. Authentication: **OAuth** (dynamic client registration, no client secret required)
4. Create/Connect and sign in on the Railway-hosted authorization page using `APP_PASSWORD`.
5. Install/enable the connected plugin and test by asking to list training profiles.

Deployment must have finished before attempting connection. The username/password interface for the journal and the OAuth authorization form are separate. If endpoint discovery fails, check Railway logs and verify the new deployment includes `mcp.js`.

The OAuth redirect allowlist intentionally accepts ChatGPT/OpenAI HTTPS callback domains, not arbitrary websites. Renewing tokens requires a connected client. Do not add sensitive medical information before reviewing your own data handling requirements.
