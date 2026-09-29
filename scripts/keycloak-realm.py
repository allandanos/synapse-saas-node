"""Copy the reference's dev realm for this run.

The reference tree is read-only, and the shipped realm only knows the
reference's own 8000/3000 — so the copy adds the API and console origins this
run actually uses. Nothing else changes: users, client secret and realm name
are verbatim.
"""

import json
import os
import sys

source, destination = sys.argv[1], sys.argv[2]
realm = json.load(open(source, encoding="utf-8"))
redirects = [f"{os.environ['API_URL']}/*", f"{os.environ['CONSOLE_URL']}/*"]
origins = [os.environ["API_URL"], os.environ["CONSOLE_URL"]]

for client in realm.get("clients", []):
    if client.get("clientId") == "synapse-web":
        client["redirectUris"] = sorted(set(client.get("redirectUris", []) + redirects))
        client["webOrigins"] = sorted(set(client.get("webOrigins", []) + origins))

with open(destination, "w", encoding="utf-8") as handle:
    json.dump(realm, handle, indent=2)
