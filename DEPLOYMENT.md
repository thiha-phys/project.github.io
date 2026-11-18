# Accounts and presenter-approved fan control

This project contains Cloudflare Pages Functions for accounts and authorization, a D1 schema for durable accounts/sessions, and a Durable Object coordinator for temporary control requests, leases, WebSocket bridge traffic, and in-memory live telemetry. The ESP32-C3 controls the fan locally and advertises an encrypted BLE service. The presenter's MacBook runs the bridge in Chrome; audience devices need only a browser and Internet access.

## Cloudflare setup

1. Deploy this repository as a **Cloudflare Pages** project with the repository root as the build output directory. GitHub Pages cannot run these Functions or provide D1 bindings.
2. Create one D1 database named `mu-physics-accounts`. Copy its database ID into `wrangler.toml` in place of `SET_AFTER_CREATING_D1`.
3. Apply the account migration to the remote database:

   ```sh
   npx wrangler d1 migrations apply mu-physics-accounts --remote
   ```

4. Deploy the coordinator Worker:

   ```sh
   npx wrangler deploy --config coordinator/wrangler.toml
   ```

   Temporary request history is retained for 30 days by default. Change
   `CONTROL_HISTORY_RETENTION_DAYS` in `coordinator/wrangler.toml` to a value
   from 1 to 3650 and redeploy the Worker to adjust it.

5. In the Pages project settings, bind the D1 database as `DB` and bind the coordinator Durable Object namespace as `FAN_COORDINATOR` (class `FanControlCoordinator`, Worker `mu-physics-fan-coordinator`). Redeploy Pages after changing bindings.
6. Add this as a **server-side Pages setting**, never as a browser role or user-editable value:
   - `PRESENTER_USER_ID`: the user ID of the trusted presenter account.
7. Open `/account.html` on the deployed HTTPS site and create the presenter's ordinary account. In D1, look up that account's ID using the private email address, then set `PRESENTER_USER_ID` in Pages settings and redeploy. No role is selected or stored in the browser.
8. Upload the BLE firmware as described in `ESP32_Fan_Controller/README.md`. Keep the MacBook online over the room network, sign in as the presenter in Google Chrome, open `/bridge.html`, select the ESP32, and complete Bluetooth pairing using the PIN printed in Serial Monitor.

The WebSocket endpoint verifies the presenter's server-side account session. No bridge secret is embedded in browser JavaScript. The coordinator sends only server-authorized commands to the bridge. Do not deploy to production until the account/control tests pass against a preview and the physical ESP32 BLE pairing, telemetry, fan commands, and disconnect fallback have been verified.

## Local development and Electronic page access

- Serve the site through Cloudflare Pages local development so Functions, D1, Durable Objects, and WebSockets are available. Opening `electronic.html` directly or using a static-only web server does not exercise its authenticated API routes.
- Keep the root Pages configuration's D1 ID and the local/preview bindings pointed at a dedicated test database and coordinator. Never connect local testing to the account database used by a live seminar.
- `/electronic.html` requires a valid account session. Without one, Pages sends the browser to `/account.html` with a return path; after login it returns to Electronic. The service worker leaves navigations and `/api/` requests to the network so it cannot serve a cached protected page or intercept the login redirect.
- Logout removes the current session row before attempting temporary-control cleanup and expires the session cookie. If control cleanup is unavailable, the user remains signed out and the hardware lease expires safely.

## Accounts and data

- Registration collects only full name, email, password, and confirmation. Email is normalized to lowercase; D1 enforces uniqueness. Confirmations and plain passwords are never stored.
- Passwords use PBKDF2-HMAC-SHA-256 with a per-account random salt and 310,000 iterations. Session tokens are random, stored as SHA-256 hashes in D1, and sent only in Secure, HttpOnly, SameSite cookies. Sessions expire after 30 days; logout removes the active session and explicitly expires the matching cookie.
- Presenter access comes from the protected server-side `PRESENTER_USER_ID` setting, not a form field or client-side role.
- D1 stores accounts and authentication sessions only. Durable Object storage holds temporary control requests, approval, and lease data. Temperature, fan speed, mode, and other live telemetry exist only in the coordinator's memory and are sent to audience browsers over WebSockets; they are never written to D1 or Durable Object storage. After a Durable Object restart, the display remains offline until the bridge sends a new telemetry update. The presenter reset button clears temporary control state and leaves accounts intact.
- Do not delete the D1 database for seminar cleanup. Before destructive schema work, export a backup and verify that it is non-empty:

  ```sh
  npx wrangler d1 export mu-physics-accounts --remote --output=mu-physics-accounts-backup.sql
  ```

  For a safe restore, create a separate recovery database rather than overwriting the existing account database:

  ```sh
  npx wrangler d1 create mu-physics-accounts-restore
  npx wrangler d1 execute mu-physics-accounts-restore --remote --file=mu-physics-accounts-backup.sql
  npx wrangler d1 execute mu-physics-accounts-restore --remote --command="SELECT COUNT(*) AS users FROM users;"
  ```

  Verify the restored accounts and schema before intentionally switching the Pages `DB` binding and `database_id` to the recovery database. Keep both databases until the restored site is confirmed. Practice this process against a separate test database first. Keep backup files private because they contain account email addresses and password hashes. D1's undelete/time-travel features are additional recovery options, not a substitute for backups.
- Current Cloudflare D1 Free limits are 500 MB per database and 5 GB per account. A set of 70 ordinary account rows is tiny compared with these limits. D1 quotas are provider limits, not a fixed 4 GB device allocation. See Cloudflare's [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [D1 backup/restore documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## Required verification checklist

The following cases must be run against a non-production Pages preview with a test D1 database before using the account/control flow with seminar participants:

1. New account registration.
2. Password/confirmation mismatch.
3. Duplicate email registration.
4. Duplicate email with different casing.
5. Successful login.
6. Returning browser with a valid cookie.
7. Login from a new browser/device.
8. Logout invalidates the session.
9. Expired and invalid session handling.
10. Authenticated control request.
11. Presenter sees the right name/email/time/status.
12. Presenter approval and rejection.
13. Presenter revocation and immediate takeover.
14. Unapproved and unrelated users cannot issue commands.
15. Temporary-state reset preserves the account rows.
16. An expired controller lease returns control to the ESP32's local Auto behavior.
17. Electronic-page login redirect and same-origin assets work in Pages local development and preview.
18. No telemetry values are persisted; a restarted coordinator waits for the next bridge update.

The checklist is a deployment gate, not a claim that these live Cloudflare scenarios have already been tested.

Before any production seminar, also verify in a non-production environment:

- The presenter can pair from Google Chrome on macOS, and only the presenter account can open the bridge WebSocket.
- ESP32 BLE telemetry reaches the website in real time; multiple audience browsers receive updates without needing BLE.
- Presenter and approved-controller commands work, while unapproved users and stale leases are rejected.
- Disconnecting Chrome, BLE, or the MacBook Internet link returns the ESP32 to local temperature-based Auto mode.

No production deployment is authorized by this guide.

## Verification status

- Local automated checks: `npm test` covers account registration/login/session behavior, logout invalidation and cookie clearing, protected/Electronic page routing, presenter approval and revocation, unauthorized commands, audience WebSocket telemetry, no telemetry persistence, restart recovery, lease expiry, and account retention across seminar reset. `python3 -m unittest discover -s tests -p 'test_*.py' -v` checks the D1 schema and case-insensitive email uniqueness. JavaScript syntax checks and `git diff --check` should also pass before preview.
- Not verified here: Cloudflare Pages/D1/Durable Object deployment, real Google Chrome Web Bluetooth pairing, Arduino firmware compilation/flashing, the physical sensor/fan, or a 70-browser load test. These require the configured Cloudflare preview and the actual hardware; do not treat local mock tests as hardware or production approval.
