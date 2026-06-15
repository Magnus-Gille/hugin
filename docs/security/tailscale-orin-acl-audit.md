# Tailscale → Orin SSH ACL Audit: YubiKey FIDO2 Bypass

**Date:** 2026-06-01
**Type:** Security audit (read-only inspection; no host/ACL/code changes)
**Author:** Claude Opus 4.8 (audit task)
**Classification:** Internal
**Scope:** Orin (`magnus-desktop`, Tailscale `100.127.176.78`) SSH access path and its
interaction with the tailnet and the scoped NOPASSWD sudoers grants.

---

## TL;DR

The premise of the audit — "the Tailscale path to Orin bypasses YubiKey FIDO2 SSH
auth" — is **confirmed, but the mechanism is different from the one in the original
concern**. The bypass is **not** Tailscale SSH's lack of FIDO2. It is that Orin's
**host `sshd`** lists a **plain (non-hardware) software ed25519 key** in
`authorized_keys` *alongside* the two YubiKey FIDO2 (`sk-ssh-ed25519`) keys, with **no
`AuthenticationMethods` directive requiring the hardware key**. `sshd` therefore accepts
**any one** of the three keys. The software key — which sits unprotected at
`~/.ssh/id_ed25519` on the MacBook — satisfies login on its own, over any network path,
tailnet included. The YubiKey is effectively advisory, not enforced.

A second, independent exposure exists: the tailnet's **SSH policy** (Tailscale SSH) is
configured to allow **every device in the tailnet** to reach hosts as `magnus`/`root`.
This is a separate door (the `holdAndDelegate` "check" path) that, combined with the
NOPASSWD docker/jetson sudoers grants, defines the blast radius if any tailnet device is
compromised.

**Risk rating: HIGH** (hardware-key requirement is bypassable; single-user tailnet means
any compromised device is a full SSH foothold on Orin).

---

## 1. Method and evidence handling

Everything below was gathered **read-only** from the MacBook (`magnus-macbook-air`,
`100.119.150.76`) on 2026-06-01. No host configuration, ACL, sudoers, or key material was
modified. No secrets are reproduced in this document (key fingerprints and key *types* are
not secrets).

Each claim is tagged **[VERIFIED]** (observed directly this session) or **[ASSUMED]**
(inferred, or stated in upstream context and not independently re-checked).

Commands used (all read-only):

- `tailscale status`, `tailscale whois <ip>`, `tailscale debug prefs`,
  `tailscale debug netmap` (the last exposes the `SSHPolicy` the control plane pushed to
  *this* node).
- `ssh -vv -o BatchMode=yes magnus@100.127.176.78 '<read-only cmd>'` to observe the
  handshake and read Orin's `authorized_keys` key types, `sshd_config` (non-secret
  directives), and `sudo -n -l` grant listing.

---

## 2. Tailnet inventory [VERIFIED]

`tailscale status` shows **5 devices, all owned by a single user**
(`7rmdf9mr4t@privaterelay.appleid.com`, Apple private-relay login):

| Host | Tailscale IP | OS | Role |
|------|--------------|----|------|
| `magnus-macbook-air` | `100.119.150.76` | macOS | Orchestrator laptop (audit origin) |
| `huginmunin` | `100.97.117.37` | linux | Hugin/Munin Pi (runs autonomous AI tasks) |
| `magnus-desktop` (**Orin**) | `100.127.176.78` | linux | Jetson Orin inference node |
| `nas` | `100.99.119.52` | linux | NAS / artefact delivery target |
| `iphone181` | `100.83.26.2` | iOS | Phone |

- **No device is tagged.** `tailscale debug prefs` on the MacBook reports
  `"AdvertiseTags": null`. [VERIFIED] This matters: the SSH policy (below) is written
  against **node IPs / autogroup**, not tags, so it cannot be scoped to a role.
- This MacBook does **not** run Tailscale SSH (`"RunSSH": false`). [VERIFIED]

---

## 3. The two SSH doors to Orin

### 3.1 Door A — host `sshd` on port 22 with a mixed key set (the real bypass) [VERIFIED]

A `BatchMode=yes` (non-interactive, no prompt, **no YubiKey touch**) SSH to
`magnus@100.127.176.78` **succeeded** and returned `whoami=magnus`, `hostname=magnus-desktop`.

The verbose handshake proves this is **host `sshd`, not Tailscale SSH**:

```
SSH_CONNECTION=100.119.150.76 54617 100.127.176.78 22   # dest port 22 = real sshd
debug1: Authentications that can continue: publickey,password
debug1: Server accepts key: /Users/magnus/.ssh/id_ed25519 ED25519 SHA256:VMQRl8+uBSeLY3oYQTu3inLdDFvqpgkrCzeALbmkiMw
Authenticated to 100.127.176.78 using "publickey".
```

(Tailscale SSH would intercept the session and present **no** publickey method.)

Orin's `~/.ssh/authorized_keys` contains three keys [VERIFIED]:

| Key type | Comment | Hardware-backed? |
|----------|---------|------------------|
| `sk-ssh-ed25519@openssh.com` | `yubikey-orin` | Yes (FIDO2, primary) |
| `sk-ssh-ed25519@openssh.com` | `yubikey-orin-backup` | Yes (FIDO2, backup) |
| `ssh-ed25519` | `magnus.johnson@hotmail.com` | **No (plain software key)** |

The plain key's fingerprint on Orin (`SHA256:VMQRl8+uBSeLY3oYQTu3inLdDFvqpgkrCzeALbmkiMw`)
is **exactly** the key the MacBook offered from `~/.ssh/id_ed25519`. [VERIFIED] So the
login that bypassed the YubiKey used an ordinary on-disk software key.

Orin's `sshd_config` shows **no `AuthenticationMethods` directive** and only default
(commented) `PubkeyAuthentication`/`PasswordAuthentication` lines. [VERIFIED — read of
`/etc/ssh/sshd_config` and `/etc/ssh/sshd_config.d/`, no override found]. With no
`AuthenticationMethods publickey` *restricted to the `sk-` keys* and no `Match` block, the
default is "any single accepted publickey logs you in." The two FIDO2 keys and the one
software key are therefore **equivalent** to `sshd` — the hardware requirement is
**advisory, not enforced**.

> **Correction to the original concern:** the YubiKey bypass is real, but it is not caused
> by Tailscale SSH lacking FIDO2. It is caused by a **non-FIDO2 key being present in
> `authorized_keys` with no policy requiring the FIDO2 key**. This bypass works from *any*
> network the host `sshd` is reachable on, not only the tailnet. The tailnet simply makes
> Orin reachable from every other node (§4).

### 3.2 Door B — Tailscale SSH policy ("check"/`holdAndDelegate`) [VERIFIED, with caveat]

`tailscale debug netmap` exposes the `SSHPolicy` the control plane pushed to **this**
node. **Caveat [VERIFIED limitation]:** this is the policy describing SSH *into the
MacBook*, not *into Orin* — a node only receives the SSH rules where it is the
destination. So the netmap confirms the **shape and intent** of the org's SSH policy but
is **not** the authoritative rule set for Orin as a destination. The two rules observed:

- **Rule 0** — `action.accept: true` from the MacBook's own IPs, `sshUsers: {"*":"=", "root":"root"}`
  (i.e. any local user, plus root). This is a plain **`accept`** (no re-auth check).
- **Rule 1** — `action.holdAndDelegate: ".../ssh/action/$SRC_NODE_ID/to/$DST_NODE_ID..."`
  with **principals = all 5 tailnet node IPs** (v4 + v6), `sshUsers: {"*":"=", "root":"root"}`.
  `holdAndDelegate` is the wire form of the Tailscale **`check`** action (periodic browser
  re-auth / check-mode). It also permits `root`.

**[ASSUMED, must be confirmed in the admin console]:** that Orin's inbound Tailscale-SSH
rule mirrors this — i.e. a broad `src: ["autogroup:members"]` (or all node IPs) →
`dst: [Orin]`, `users: ["autogroup:nonroot"]` or `["magnus","root"]`, with action
`check` (and possibly an `accept` for the laptop). The presence of a `holdAndDelegate`
rule covering all node IPs strongly implies Tailscale SSH is enabled tailnet-wide with a
`check` action. **This must be read from the source of truth — see §6.**

Note Door B is partly moot today: Orin reachability in §3.1 went through **host sshd on
port 22**, which Tailscale SSH does not gate. Even a perfectly locked-down Tailscale SSH
`check` rule does **not** close Door A.

---

## 4. Blast radius

**Who can SSH to Orin today:**

- **Door A (host sshd):** any actor in possession of **any one** of the three accepted
  keys, reachable over any network where Orin's port 22 is exposed. On the tailnet that is
  **every node** (no ACL was observed restricting tailnet→Orin:22 at the packet-filter
  level; [ASSUMED] the tailnet ACL is the default allow-all unless a `acls`/`grants`
  stanza says otherwise — **confirm in console**). The decisive key (`id_ed25519`) is an
  **unprotected on-disk software key** on the MacBook — no passphrase touch, no hardware.
  [VERIFIED the key is on-disk and works in BatchMode; ASSUMED no passphrase, since
  BatchMode succeeded without an agent prompt this session.]
- **Door B (Tailscale SSH):** [ASSUMED per §3.2] every tailnet member node, as `magnus`
  or `root`, subject to a periodic `check` re-auth.

**What they can do once on Orin as `magnus`** (combined with the scoped NOPASSWD sudoers
grants) [VERIFIED via `sudo -n -l`]:

- `magnus-docker-debug`: passwordless `docker ps/stats/events/logs/inspect/top/port` (read)
  **plus** `docker restart|stop|start|rm -f ollama-jetson` (lifecycle control of the
  inference container). `rm -f ollama-jetson` can destroy the running container.
- `magnus-jetson-ops`: passwordless `jetson_clocks`, `nvpmodel -m 0 / -q` (power/clock
  state), and `systemctl start|stop|restart ollama`.

The grants are **tightly scoped** (no general `docker run`, no shell, no arbitrary
`systemctl`), which is good hardening and limits *privilege escalation to root*. They do
**not** limit the SSH foothold itself.

**Worst case if a tailnet device is compromised** (e.g. the always-on autonomous Pi
running AI agents, or the laptop):

1. The attacker inherits tailnet membership → reaches Orin:22 (Door A) and/or Tailscale
   SSH (Door B).
2. If they can read `~/.ssh/id_ed25519` from the laptop (the key is unprotected on disk),
   they have a portable, hardware-free credential for Orin that works from anywhere — the
   YubiKey provides **no** protection against this path.
3. As `magnus` on Orin they get an interactive shell (full read of the user's files,
   workspace, repos) **plus** the NOPASSWD grants: they can stop/destroy/restart the
   `ollama-jetson` container and toggle Jetson power/clock state — i.e. **denial of service
   of the inference node and tampering with model serving**, without a root password.
4. The single-user, untagged tailnet means there is **no internal segmentation** to
   contain lateral movement — every node can reach every other node's SSH by default.

This is a realistic concern specifically because the Pi runs **autonomous AI runtimes** on
this same tailnet; a prompt-injection or supply-chain compromise of a task could attempt
exactly this lateral SSH.

---

## 5. Risk rating

| Dimension | Rating | Basis |
|-----------|--------|-------|
| YubiKey enforcement on Orin SSH | **HIGH** | [VERIFIED] hardware key not required; a plain on-disk key logs in with no touch. |
| Tailnet segmentation | **MEDIUM–HIGH** | [VERIFIED] single user, no tags, broad SSH principals; [ASSUMED] default allow-all packet ACL. |
| Privilege escalation to root via sudoers | **LOW** | [VERIFIED] grants are narrowly scoped commands, not a shell. |
| Availability/integrity of inference node | **MEDIUM** | [VERIFIED] NOPASSWD container + power controls allow DoS/tamper without root. |

**Overall: HIGH** — driven by the bypassable hardware-key requirement on a node reachable
from an autonomous-agent tailnet.

---

## 6. What the human must verify (source of truth not readable locally)

The packet-filter ACL and the authoritative Tailscale **SSH** policy live in the **admin
console / tailnet policy file** (`https://login.tailscale.com/admin/acls`), which is **not
readable from a node**. The netmap (§3.2) only shows the slice where this node is the
*destination*. Please check, in the policy file:

1. **`ssh` rules** — for each rule whose `dst` includes Orin (`tag:` or `magnus-desktop`):
   - `action`: is it `"accept"` or `"check"`? `accept` = no re-auth ever. Prefer `check`.
   - `src`: is it `["autogroup:members"]` / all nodes, or scoped to specific
     tags/users/devices? Broad `src` is the blast-radius driver.
   - `users`: does it include `root` or `autogroup:root`? Observed netmap rules permit
     `root` — confirm whether Orin's inbound rule does too, and drop root if so.
   - `checkPeriod`: if `check`, how long is the grace window?
2. **`acls` / `grants` (packet filter)** — is there any rule *restricting* tailnet→Orin:22,
   or is it the default allow-all? If allow-all, Door A is reachable from every node.
3. **Tags** — there are none today. Without tags, SSH rules cannot be scoped by role
   (e.g. "only the laptop may SSH Orin; the Pi may not").
4. **Orin host `sshd`** — confirm there is no `Match`/`AuthenticationMethods` override in a
   file this audit could not read with elevated privilege (only the non-secret directives
   were read).

---

## 7. Recommended hardening (no change made by this audit)

In rough priority order:

1. **Enforce the hardware key in Orin's host `sshd` (closes Door A — highest impact).**
   Either remove the plain `ssh-ed25519 magnus.johnson@hotmail.com` key from Orin's
   `authorized_keys`, or, if a software key must remain for break-glass, gate it: e.g.
   restrict the plain key to a bastion source, or set
   `PubkeyAcceptedAlgorithms`/`AuthenticationMethods` so that the FIDO2 (`sk-`) key is
   required for normal logins. Removing the plain key is the clean fix; keep the YubiKey
   primary + backup. **Verify the YubiKey path still works before removing the fallback,
   and keep the backup key enrolled to avoid lock-out.**
2. **Passphrase-protect (or hardware-back) `~/.ssh/id_ed25519` on the laptop.** Today it is
   an unprotected portable credential. If Door A's plain key is removed (rec. 1) this key
   stops mattering for Orin; until then, at minimum add a passphrase.
3. **Tailscale SSH: use `check`, not `accept`, for any rule targeting Orin**, with a short
   `checkPeriod`, so even tailnet-internal SSH forces periodic re-auth. (Note: `check`
   still does not enforce FIDO2 — that is rec. 1's job — but it bounds the window of a
   stolen session.)
4. **Scope the SSH `src` and introduce tags.** Tag the laptop (e.g. `tag:admin`) and the
   Pi (e.g. `tag:agent`) and write the Orin SSH rule as
   `src: ["tag:admin"] → dst: ["tag:orin"]`, explicitly **excluding** the autonomous Pi
   from SSH to Orin. The Pi reaching Orin for inference should go over the **Ollama HTTP
   port**, not SSH.
5. **Drop `root` from Orin's SSH `users`.** Observed policy permits `root`; the NOPASSWD
   grants already cover the legitimate ops without a root shell.
6. **Add a packet-filter ACL** restricting tailnet→Orin to the ports actually needed
   (SSH from `tag:admin` only; Ollama from `tag:agent`), instead of default allow-all.

Recommendations 1, 3, 4, 5, 6 require admin-console / host changes and are **out of scope
for this audit** — filed as a GitHub issue for human action (see below).

---

## 8. Open findings (filed as issues)

- **[#98](https://github.com/Magnus-Gille/hugin/issues/98)** — Orin SSH bypasses YubiKey
  FIDO2 via a plain software key + broad tailnet SSH policy. Tracks recs. 1–6 above.

---

## 9. Verified-vs-assumed ledger

| Claim | Status |
|-------|--------|
| 5-device single-user untagged tailnet, IPs as listed | VERIFIED |
| SSH to `magnus@100.127.176.78` succeeds in BatchMode, no YubiKey touch | VERIFIED |
| That login used host sshd:22, not Tailscale SSH, via `~/.ssh/id_ed25519` | VERIFIED |
| Orin `authorized_keys` = 2× `sk-ssh-ed25519` (yubikey) + 1× plain `ssh-ed25519` | VERIFIED |
| Plain key fingerprint matches the laptop's `id_ed25519` | VERIFIED |
| Orin `sshd_config` has no `AuthenticationMethods`/`Match` override (in readable files) | VERIFIED |
| NOPASSWD grants: scoped docker (incl. `rm -f ollama-jetson`) + jetson power/ollama systemctl | VERIFIED (`sudo -n -l`) |
| Netmap `SSHPolicy`: rule 0 `accept` (self), rule 1 `holdAndDelegate`/`check` over all node IPs, both allow `root` | VERIFIED (but describes SSH *into the laptop*, not Orin) |
| Orin's inbound Tailscale-SSH rule mirrors rule 1 (broad src, check action, root allowed) | ASSUMED — confirm in admin console |
| Tailnet packet ACL is default allow-all (no tailnet→Orin:22 restriction) | ASSUMED — confirm in admin console |
| Laptop `id_ed25519` has no passphrase | ASSUMED (BatchMode succeeded with no agent prompt) |

---

## 10. Sources

- Live read-only inspection of the tailnet and Orin, 2026-06-01 (commands in §1).
- Upstream context: `decisions/orin-ssh-auth` (Munin), repo `STATUS.md`.
- Tailscale SSH action semantics (`accept` vs `check`/`holdAndDelegate`):
  Tailscale SSH documentation.
