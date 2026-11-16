# fbf-gate

The public entry page of a private study app. It holds **no learning content and no
progress**: only a login form, a service worker and `vault.json`, a token encrypted
with a passphrase.

With the passphrase, the page decrypts the token, downloads the app from a private
repository into the browser's cache and opens it. It then works offline, and progress
syncs back to the private repository.

Published by `fbf web publish` from the `web/gate/` folder of the Fluent by Fall
repository. Design: `docs/adr/0010-web-delivery-and-sync.md` there.
