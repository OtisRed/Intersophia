# Staging candidate flow

The application adds accounts for invited candidates only. Submitting a declaration records a pending application. Member access and membership decisions are out of scope.

## Local verification

Create a Python virtual environment, install `requirements.txt`, then run `python -m unittest -v test_membership`. The tests use a temporary database and replace the provider response after token validation.

## Initial deployment

- Deploy the tested `smoke` revision to a root-owned versioned directory and point `/opt/intersophia-accounts/current` at it. Install dependencies in `/opt/intersophia-accounts/venv`.
- Run the service from `deploy/intersophia-accounts.service` with a dedicated local account. Install and include `deploy/staging-accounts.conf` only in the existing staging Nginx server. Keep the current static deployment and Cloudflare tunnel.
- Create the private root-owned mode-0600 `/etc/intersophia-accounts/staging.env` containing a random `INTERSOPHIA_SESSION_KEY` of at least 32 characters. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the staging OAuth Web application. The callback is exactly `https://dev.intersophia.pl/auth/google/callback`. Use scopes `openid email profile`. Keep the client and database separate from production.
- Start the service. Run `nginx -t` before reloading. Check `/auth/health` and the public FAQ. `google_configured: false` means the Google integration cannot yet be exercised. Replacing the backend version and reloading the service is a separate operation from the current static publishing timer.

Issue a test invitation under the service account with the same private environment and working directory:

```sh
flask --app membership:create_app invite TEST_ACCOUNT@gmail.com --hours 48
```

Share the output directly with the tester. Keep real invite links and account addresses out of PRs and logs. Run the browser smoke with the invited Google account and confirm that a different Gmail cannot claim it, the candidate can submit only once, and the pending state persists after logout and login.
