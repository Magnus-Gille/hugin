# Contributing

Thank you for helping improve Hugin.

## Development setup

Use Node.js 20 or newer:

```bash
npm ci
npm run build
npm test
```

Keep changes focused. For non-trivial behavior, add a regression test that fails
for the intended reason before implementing the fix. Run the focused test while
iterating and the full suite before opening a pull request.

## Pull requests

- Explain the user-visible behavior and security implications.
- Update README, `.env.example`, schemas, and tests when configuration changes.
- Preserve the fail-closed behavior of authentication, authorization,
  sensitivity, managed checkouts, artifact delivery, and result finalization.
- Do not weaken tests or coverage to admit a change.
- Do not include generated host results, real task content, credentials,
  deployment topology, personal paths, or customer data.

Substantive security, authorization, schema, worker, or data-integrity changes
should receive an independent review before merge.

## Issues and security

Ordinary bugs and proposals may use GitHub Issues. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).
