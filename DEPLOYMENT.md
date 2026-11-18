# Accounts and presenter-approved fan control

This project contains Cloudflare Pages Functions for accounts and authorization, a D1 schema for durable accounts/sessions, and a Durable Object coordinator whose entire seminar state is volatile in-memory state. The ESP32-C3 controls the fan locally and advertises an encrypted BLE service. The presenter's MacBook runs the bridge in Chrome; audience devices need only a browser and Internet access.

## Cloudflare resources and configuration

The Pages configuration and coordinator Worker configuration are deliberately separate:

- The Pages project uses the root `wrangler.toml`; its current configured name is `mu-physics-project` and its build output is the repository root.
- The standalone Worker uses `coordinator/wrangler.toml`; its `name` is `mu-physics-fan-coordinator`, and its entry point is `coordinator/worker.js`.
- `FAN_COORDINATOR` is a **Durable Object binding**, not a Service Binding. Pages refers to script `mu-physics-fan-coordinator` and class `FanControlCoordinator`. Those names must match the coordinator Worker configuration and export exactly.
- The coordinator migration `v1` registers the `FanControlCoordinator` Durable Object class. The Worker does not use Durable Object storage for seminar state. On instance startup, it deletes the legacy `state` and `requests` keys left by older versions, then keeps all new seminar state in memory. This does not create, delete, or migrate the account D1 database.
- Pages also needs its existing D1 database bound as `DB`. The root `wrangler.toml` intentionally has `SET_AFTER_CREATING_D1` instead of a real database ID. Before using Wrangler for Pages deployment, replace it with the ID of the **intended existing** account database, or ensure the Pages dashboard binding targets that same database. Do not create or delete a production database for this Worker-binding fix.
- Set `PRESENTER_USER_ID` as a server-side Pages variable to the trusted presenter's actual account ID. Do not put it in browser code.

Before deploying, confirm the Cloudflare account you are logged into, the existing Pages project name, the existing D1 database name and ID, and the trusted presenter account ID. The script/class/binding names above are already defined by this repository; no resource IDs are supplied or assumed here.

### What a coordinator restart means

Control requests, approvals/rejections, current controller and lease, telemetry, pending command acknowledgements, and WebSocket metadata exist only in the current coordinator instance. A restart/eviction clears them and closes the in-memory sockets. Users must submit new requests, the presenter must approve again, and the presenter must reconnect the bridge. No old permission is restored. The ESP32's local temperature-based Auto control and watchdog remain responsible for safe fan operation during Cloudflare or bridge loss.

## Required deployment order

Do not publish Pages until the referenced Worker script exists. The reported `8000109: Script mu-physics-fan-coordinator not found` is caused by publishing Pages before deploying the separately configured coordinator Worker; the two script names in the repository already match.

1. From the repository root, authenticate Wrangler if needed:

   ```sh
   npx wrangler login
   ```

2. Deploy the coordinator Worker first. This command targets the script named `mu-physics-fan-coordinator` in the currently selected Cloudflare account and applies its `v1` Durable Object migration:

   ```sh
   npx wrangler deploy --config coordinator/wrangler.toml
   ```

   Do not run this command until you have confirmed the intended Cloudflare account. The coordinator retains control-request history for 30 days by default; `CONTROL_HISTORY_RETENTION_DAYS` in `coordinator/wrangler.toml` can be set from 1 to 3650.

3. Verify in Cloudflare Dashboard → **Workers & Pages** that `mu-physics-fan-coordinator` has a successful active deployment. Confirm its Durable Object class is `FanControlCoordinator`. Do not continue if the script or class is missing. The Worker’s default HTTP handler intentionally returns 404; verify its deployment in the dashboard rather than treating a browser visit to its root URL as a health check.

4. In the Pages project settings, configure/check the bindings for each environment you intend to deploy:
   - `FAN_COORDINATOR`: Durable Object class `FanControlCoordinator`, Worker script `mu-physics-fan-coordinator`.
   - `DB`: the intended existing D1 account database.
   - `PRESENTER_USER_ID`: the actual trusted presenter account ID as a server-side variable.

   The root `wrangler.toml` already declares the `FAN_COORDINATOR` Durable Object binding. Its `script_name` must remain exactly equal to the coordinator Worker's `name`.

5. Only after the Worker verification and Pages binding checks, deploy Pages. For a preview, replace `YOUR_PAGES_PROJECT` and `YOUR_PREVIEW_BRANCH` with the exact existing Pages project name and a branch that is **not** the production branch:

   ```sh
   npx wrangler pages deploy . --project-name YOUR_PAGES_PROJECT --branch YOUR_PREVIEW_BRANCH
   ```

   The root config currently names the Pages project `mu-physics-project`; use that only if it matches the project shown in your Cloudflare Dashboard. A production-branch deployment publishes Pages to production. Wrangler Pages preview branches still use the binding configured for that Pages environment; use a separate preview coordinator binding if you need to isolate preview control state from an active seminar.

This deployment error does not require an account migration. Do not apply D1 migrations as part of this fix unless you independently confirm the existing database schema needs them and have selected the correct database.

The WebSocket endpoint verifies the presenter's server-side account session. No bridge secret is embedded in browser JavaScript. The coordinator sends only server-authorized commands to the bridge. Before a production seminar, verify the account/control flow against the intended environment and test physical BLE pairing, telemetry, fan commands, and disconnect fallback.

## Local development and Electronic page access

- Serve the site through Cloudflare Pages local development so Functions, D1, Durable Objects, and WebSockets are available. Opening `electronic.html` directly or using a static-only web server does not exercise its authenticated API routes.
- Keep the root Pages configuration's D1 ID and the local/preview bindings pointed at a dedicated test database and coordinator. Never connect local testing to the account database used by a live seminar.
- `/electronic.html` requires a valid account session. Without one, Pages sends the browser to `/account.html` with a return path; after login it returns to Electronic. The service worker leaves navigations and `/api/` requests to the network so it cannot serve a cached protected page or intercept the login redirect.
- Logout removes the current session row before attempting temporary-control cleanup and expires the session cookie. If control cleanup is unavailable, the user remains signed out and the hardware lease expires safely.

## Accounts and data

- Registration collects only full name, email, password, and confirmation. Email is normalized to lowercase; D1 enforces uniqueness. Confirmations and plain passwords are never stored.
- Passwords use PBKDF2-HMAC-SHA-256 with a per-account random salt and 310,000 iterations. Session tokens are random, stored as SHA-256 hashes in D1, and sent only in Secure, HttpOnly, SameSite cookies. Sessions expire after 30 days; logout removes the active session and explicitly expires the matching cookie.
- Presenter access comes from the protected server-side `PRESENTER_USER_ID` setting, not a form field or client-side role.
- D1 stores accounts and authentication sessions only. Control requests, approval/rejection history, controller permissions, lease state, telemetry, command acknowledgements, and WebSocket metadata are held only in coordinator memory. The coordinator uses ordinary in-memory WebSocket connections rather than Durable Object hibernation attachments. No temporary coordination or sensor data is written to D1, Durable Object storage, logs, or analytics. On restart, all temporary state is lost, old permissions cannot be claimed, and the audience display stays offline until the bridge reconnects and sends new telemetry. The presenter reset button clears temporary in-memory state and leaves accounts intact.
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

- Local automated checks: `npm test` covers account registration/login/session behavior, logout invalidation and cookie clearing, protected/Electronic page routing, presenter approval and revocation, unauthorized commands, audience WebSocket telemetry, no temporary-state persistence, restart reset, lease expiry, and account retention across seminar reset. `python3 -m unittest discover -s tests -p 'test_*.py' -v` checks the D1 schema, case-insensitive email uniqueness, and Pages/Worker binding-name and migration consistency. JavaScript syntax checks and `git diff --check` should also pass before preview.
- Not verified here: Cloudflare Pages/D1/Durable Object deployment, real Google Chrome Web Bluetooth pairing, Arduino firmware compilation/flashing, the physical sensor/fan, or a 70-browser load test. These require the configured Cloudflare preview and the actual hardware; do not treat local mock tests as hardware or production approval.
