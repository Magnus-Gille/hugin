# M5 gateway-key rotation

`scripts/rotate-m5-gateway-key.sh` performs the staged M5 gateway-key rollout
from the owner's workstation. It reads all deployment-specific values from a
local shell config; start from
`scripts/m5-key-rotation.env.example`, replace every placeholder, and keep the
real config outside Git. The default config path is
`~/.config/hugin/m5-key-rotation.env`; use `--config PATH` to override it.

Run a no-contact preview first:

```sh
scripts/rotate-m5-gateway-key.sh --config PATH --dry-run
```

Then run the rotation:

```sh
scripts/rotate-m5-gateway-key.sh --config PATH
```

The script runs the gateway CLI through the configured service-sandbox wrapper,
parses the staged plan and the new key's gateway-reported expiry separately from
the old-key overlap deadline, and streams the new key directly from the gateway
SSH process into the service-host updater. The key is not printed,
placed in an argument, or stored in a workstation file. The updater replaces
exactly one `HOMESERVER_GATEWAY_API_KEY` line, sets
`HOMESERVER_GATEWAY_KEY_EXPIRES_AT`, preserves mode `0600`, restarts the user
unit, waits for the configured health URL, and performs the authenticated
protected-route probe before `keys preflight` and `keys commit`.

Rotation temporary files on the service host use a recognizable prefix and are
cleaned on the next run only when they are regular files owned by the service
user and older than 24 hours. Any failure after the service write restores the
previous key and expiry, restarts the service, calls `keys abort`, and exits
non-zero. Interrupts apply the same step-aware recovery and stop active stage or
write children. If commit acknowledgement is ambiguous, the script queries
authoritative gateway rotation state; a committed or unknowable outcome retains
the new key and requires manual recovery rather than risking an old key that
the gateway may have revoked. Output is limited to steps, the plan id, HTTP
codes, and the new expiry; the plaintext key must never be included in logs or
test diagnostics.

Hugin exposes the content-blind `homeserver_credential` object in `/health`:
`expires_at`, `days_remaining`, and `state` (`ok`, `expiring`, `expired`, or
`unknown`). Values under seven days cause a once-per-day warning while the
dispatcher is running. Missing or invalid expiry values degrade to `unknown`.

When `gille-inference` adds hardware-key gating, the rotation workflow must
pause at that gate and wait for the owner's touch before continuing.
