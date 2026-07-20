# Third-party notices

The [MIT license](LICENSE) applies to Hugin's own source code. Dependencies and
external services retain their own licenses and terms; installing or using
Hugin does not relicense them. Review `package-lock.json` and each installed
package's metadata for the dependency versions in a particular build.

## Anthropic Claude Agent SDK

Hugin's Claude executor directly depends on
[`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript).
The installed package identifies its license as “SEE LICENSE IN README.md” and
states that use is subject to Anthropic's applicable legal agreements. Using
that executor therefore requires the operator to review and accept the
[Anthropic legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance)
that apply to their use.

The Ollama-compatible, OpenCode, Codex CLI, and other executor paths are
separate from the Claude Agent SDK path, although the SDK remains a dependency
of the standard Hugin installation. This notice is for transparency and is not
a conclusion about whether any particular use is legally permitted.
