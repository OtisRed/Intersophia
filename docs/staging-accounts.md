# Staging member flow

The application gives invited users basic member access when they log in. The first visit shows a placeholder for community rules and a “Rozumiem” button. This only dismisses the welcome screen. There is no declaration submission or approval. After the welcome step a member can generate a 48-hour one-time link for a Gmail address and copy it for manual delivery. The service records the issuing member and allows up to ten links per member per 24 hours. The old declaration table and template are kept temporarily but are no longer used by the panel.

## Local verification

Create a Python virtual environment, install `requirements.txt`, then run `python -m unittest -v test_membership`. The tests use a temporary database and replace the provider response after token validation.

## Initial deployment

- Deploy the tested `smoke` revision to a root-owned versioned directory and point `/opt/intersophia-accounts/current` at it. Install dependencies in `/opt/intersophia-accounts/venv`.
- Run the service from `deploy/intersophia-accounts.service` with a dedicated local account. Install and include `deploy/staging-accounts.conf` only in the existing staging Nginx server. Keep the current static deployment and Cloudflare tunnel.
- Create the private root-owned mode-0600 `/etc/intersophia-accounts/staging.env` containing a random `INTERSOPHIA_SESSION_KEY` of at least 32 characters. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the staging OAuth Web application. The callback is exactly `https://dev.intersophia.pl/auth/google/callback`. Use scopes `openid email profile`. Keep the client and database separate from production.
- Start the service. Run `nginx -t` before reloading. Check `/auth/health` and the public FAQ. `google_configured: false` means the Google integration cannot yet be exercised. Replacing the backend version and reloading the service is a separate operation from the current static publishing timer.

To assign the first Opiekun after their normal invited Google sign-in, run
`flask --app membership:create_app bootstrap-guardian <gmail>` with the staging
service account, working directory and private environment. This operation
requires an existing active account, is idempotent for that account and refuses
to assign a second Opiekun. Use the Dostęp tab to assign or remove the Zarząd
role or revoke panel access. Revocation applies on the next authenticated request
and prevents future sign-ins by that account.

Under Zaproś, members see and can revoke their own active invitations. Zarząd
and Opiekun can see and revoke all active invitations, including CLI-issued links.
Revocation also expires the link so a backend rollback cannot reactivate it.
Links replaced before revocation tracking was introduced remain listed as expired.

Issue a test invitation under the service account with the same private environment and working directory:

```sh
flask --app membership:create_app invite TEST_ACCOUNT@gmail.com --hours 48
```

Share the output directly with the tester. Keep real invite links and account addresses out of PRs and logs. Run the browser smoke with the invited Google account and confirm that a different Gmail cannot claim it, “Rozumiem” opens the member panel, and the welcome screen is skipped after logout and login.
