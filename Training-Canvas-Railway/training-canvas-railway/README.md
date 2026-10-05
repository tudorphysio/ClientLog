# Training Canvas — Railway version

Standalone, single-user client training tracker. Open grid canvas, draggable client cards, custom boards, complete session histories, manual times, exercises, and JSON export. Records are stored in SQLite on your Railway volume. No external database or npm dependencies are required.

## Deploy to Railway

1. Extract this ZIP. Create a NEW GitHub repository and upload the contents of the training-canvas-railway folder. package.json, Dockerfile, and server.js must be at the repository root.
2. In Railway, create a NEW service using Deploy from GitHub Repo and select this repository. Keep it separate from the existing PT Client Funnel service and database.
3. Attach a volume to this new service with mount path `/data`. This is required: the app refuses to start on Railway without a volume, to avoid saving client records to temporary storage.
4. Add service variables:
   - APP_USERNAME: your chosen login name (for example, tudor).
   - APP_PASSWORD: a strong password of your choice. Do not put it in GitHub.
   - DATA_DIR: /data
5. Redeploy after attaching the volume and setting the variables. Railway builds the included Dockerfile automatically. The app uses Railway's PORT variable.
6. Under service Settings → Networking, Generate Domain. Open the URL and enter your chosen username and password when the browser asks.

Use one service replica. Do not delete the volume; it contains your client histories. Configure Railway volume backups and use the app's Export button for an additional JSON copy. This is a fresh independent installation; records from the earlier hosted version are not included in this source ZIP.

## Local use

Install Node.js 24 or newer. Set APP_USERNAME and APP_PASSWORD in your environment, then run `npm start`. Open http://localhost:3000. Local records are kept in ./data. There is no installation step because the app has no npm dependencies.

## Included files

- app.js: the canvas interface and application routes.
- server.js: Node server, password protection, and persistent SQLite storage.
- Dockerfile and railway.json: Railway deployment configuration.
- package.json: start command.

## Integration later

The frontend uses GET /api/records and PUT /api/records/:id. Records have stable IDs and a kind of board or client; a client contains its session history. These routes can be adapted to the main app later. This package does not connect to or modify the existing app or database.

## Validation

Checked authentication, client save/read, updating an existing client, persistence after restart, invalid input rejection, HTML/JavaScript syntax, and the generated ZIP contents. Actual Railway deployment and visual browser testing have not been performed.

Railway documentation: https://docs.railway.com/volumes and https://docs.railway.com/builds/dockerfiles
