# Training Canvas — flexible daily cards

This is a **standalone, no-build prototype** in `training-canvas/index.html`, intentionally separate from the existing production application.

## How to try it
Open `index.html` in a browser (or serve the folder with any static file server). No dependencies are required.

## Daily cards
- Create training, goal, habit or milestone cards.
- Every card is a **free-text note**. No mandatory sets, reps, exercises, weights or questions.
- Edit the title and write anything in the note.
- Drag card headers, pan the canvas, zoom with the mouse wheel, connect cards with ↗, and fit all cards.
- Export and import JSON backups.

## Persistence and deployment
This prototype saves to **this browser's localStorage only**; it does **not** sync between devices or clients and should not yet be treated as a production client-record system. Export backups before clearing browser data.

The existing GitHub/Railway production deployment is deliberately unchanged. The next step is to integrate this UI with the existing server and authentication after verifying the production application structure, enabling persistent server-backed cards and trainer/client separation.

## Intended design direction
Card dates and types are optional conveniences; the body remains unrestricted, exactly like a sticky note.
## Tablet-first business workspace (November 20, 2026)
- Refined coach journal visual design: near-white canvas, ivory paper cards, quiet gold edging, graphite type.
- Larger touch targets, clear zoom +/- controls for tablets, draggable card headers and unrestricted note fields.
- Workspace selector and **+ Profile** create separate browser-local sets of cards for demonstration.
- There is **no authentication, user permission model, server database, or cross-device sync yet**. Do not put sensitive real client records in this prototype. LocalStorage data is not a secure professional records system.
- This is a feature branch / pull request, not a live tablet app or Railway release. The app must be integrated with authenticated backend storage before actual client use.
