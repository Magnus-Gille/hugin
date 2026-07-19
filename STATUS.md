# Hugin status

This public tree is preparing for its first external release.

Current release-readiness work:

- managed repository tasks fail before model execution if Hugin cannot create
  the isolated task branch;
- artifact delivery has no installation-specific default target and requires an
  explicit `HUGIN_DELIVERY_TARGETS` allowlist;
- deployment-specific security audits and generated host benchmark results are
  excluded from the public tree;
- setup, architecture, security, and contribution documentation is public and
  installation-neutral.

Deployment history, live host state, credentials, internal incidents, and
operator-specific recovery notes belong in a private operations repository.

Before changing repository visibility, audit the complete Git history and the
hosting provider's issues, pull requests, comments, Actions logs, releases, and
attachments. Sanitizing the current branch does not remove historical copies.
