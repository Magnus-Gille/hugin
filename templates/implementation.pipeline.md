## Task: ${title}

- **Runtime:** pipeline
- **Sensitivity:** internal
- **Submitted by:** ${submittedBy}
- **Submitted at:** ${submittedAt}

### Pipeline

Phase: Plan
  Runtime: claude-sdk
  Context: repo:${repo}
  Timeout: 120000
  Prompt: |
    You are a software architect. Produce an implementation plan for the following feature:

    ${featureDescription}

    Your plan must include:
    1. A brief description of the feature and its goals.
    2. The files and modules that need to be created or modified.
    3. The approach: key data structures, algorithms, and APIs involved.
    4. Edge cases and failure modes to handle.
    5. A testing strategy: unit tests, integration tests, and how to verify correctness.
    6. Any risks or open questions before writing code.

    Be specific. This plan will be handed to an implementer — vague instructions produce vague code.

Phase: Implement
  Depends-on: Plan
  Runtime: claude-sdk
  Context: repo:${repo}
  Timeout: 300000
  Capabilities: tools, code
  Prompt: |
    You are an implementer. Following the plan, implement the feature:

    ${featureDescription}

    Guidelines:
    - Follow the existing code style and conventions in the repo.
    - Write tests alongside the implementation (not after).
    - Keep commits small and focused.
    - Do not introduce unnecessary dependencies.
    - If you discover the plan needs revision, note it but keep moving.

    When done, summarize what you implemented and what remains.

Phase: Review
  Depends-on: Implement
  Runtime: ollama-pi
  Timeout: 180000
  Prompt: |
    You are a code reviewer. The following feature was just implemented:

    ${featureDescription}

    Review the implementation for:
    - Correctness relative to the stated goals.
    - Adherence to the plan from the planning phase.
    - Code quality: naming, structure, error handling, test coverage.
    - Any concerns or follow-up tasks that should be filed.

    Produce a concise review verdict:
    - What was done well.
    - What needs fixing before the work is complete.
    - Suggested follow-up tasks (not blockers, but improvements worth tracking).
