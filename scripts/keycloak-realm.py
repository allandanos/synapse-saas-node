"""Copy the reference's dev realm for this run.

The reference tree is read-only. Two things are added to the copy, and nothing
else (users, client secret, realm name are verbatim):

1. the API and console origins this run actually uses — the shipped realm only
   knows the reference's own 8000/3000;
2. `loginTheme: synapse` (scripts/keycloak-theme), which is the stock Keycloak
   login page with the password-visibility toggle relabelled. Keycloak labels
   that button "Show password", so `getByLabel(/password/i)` — what the
   reference's `apps/web/e2e/sso.spec.ts:20` uses to reach the password FIELD —
   matches two elements and trips Playwright's strict mode. The spec is never
   edited; the fixture stops being ambiguous.
"""

import json
import os
import sys

source, destination = sys.argv[1], sys.argv[2]
realm = json.load(open(source, encoding="utf-8"))
redirects = [f"{os.environ['API_URL']}/*", f"{os.environ['CONSOLE_URL']}/*"]
origins = [os.environ["API_URL"], os.environ["CONSOLE_URL"]]

realm["loginTheme"] = "synapse"

for client in realm.get("clients", []):
    if client.get("clientId") == "synapse-web":
        client["redirectUris"] = sorted(set(client.get("redirectUris", []) + redirects))
        client["webOrigins"] = sorted(set(client.get("webOrigins", []) + origins))

with open(destination, "w", encoding="utf-8") as handle:
    json.dump(realm, handle, indent=2)
