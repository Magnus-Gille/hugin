# Security policy

## Supported versions

Hugin is pre-1.0. Security fixes are applied to the latest `main` branch; older
commits and unpublished deployment snapshots are not supported.

## Report a vulnerability

Please use GitHub's private vulnerability-reporting feature for this repository.
Do not open a public issue containing credentials, private task content,
deployment addresses, hostnames, usernames, filesystem layouts, or exploit
details. Include affected commit(s), a minimal reproduction, impact, and any
suggested mitigation. You should receive an acknowledgement within seven days.

If private reporting is unavailable, open a public issue containing only a
request for a private contact channel and no vulnerability details.

## Operational scope

Hugin can execute tools and publish repository changes. Operators are expected
to isolate its service account and workspaces, keep the network listener on
loopback or behind authenticated network controls, use signed tasks across trust
boundaries, and store all keys outside Git.

Task signing, sensitivity classification, egress filtering, prompt-injection
scanning, and output exfiltration scanning are defense-in-depth controls. They do
not make arbitrary untrusted model execution safe. See `docs/security/` and the
README's limitations before deploying.

## Public-data hygiene

Fixtures committed to this repository must be explicitly synthetic. Do not
commit production task text, generated model output, logs, benchmark captures,
database snapshots, `.env` files, IP addresses, Tailnet details, or credentials.
Before publishing a fork, scan the entire Git history plus issues, pull requests,
Actions logs, releases, and attachments; cleaning the current branch is not
history erasure.
