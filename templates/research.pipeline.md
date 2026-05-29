## Task: ${title}

- **Runtime:** pipeline
- **Sensitivity:** internal
- **Submitted by:** ${submittedBy}
- **Submitted at:** ${submittedAt}

### Pipeline

Phase: Explore
  Runtime: ollama-pi
  Timeout: 120000
  Prompt: |
    You are a research assistant. Explore and gather information on the following topic:

    ${topic}

    Your goals:
    - Identify the key concepts, definitions, and terminology.
    - Find the main open questions, debates, or areas of uncertainty.
    - Note any well-known prior work, papers, or frameworks relevant to this topic.
    - Be factual and concise. Use bullet points where helpful.

    Output a structured summary of what you have found.

Phase: Synthesize
  Depends-on: Explore
  Runtime: claude-sdk
  Timeout: 180000
  Prompt: |
    You are a research synthesizer. Review the exploration findings on the topic:

    ${topic}

    Using the exploration output as context, produce:
    1. A concise executive summary (2-3 paragraphs).
    2. A structured breakdown of the major themes or subtopics.
    3. Gaps and open questions that merit further investigation.
    4. Practical implications or next steps.

    Write clearly for a technical audience. Avoid padding.

Phase: Critique
  Depends-on: Synthesize
  Runtime: ollama-pi
  Timeout: 120000
  Prompt: |
    You are a critical reviewer. Read the synthesis on the topic:

    ${topic}

    Challenge the synthesis:
    - Are there claims that are overstated or under-evidenced?
    - Are important perspectives or counterarguments missing?
    - Is the framing biased in any way?
    - What would weaken or strengthen the conclusions?

    Produce a critique with specific, actionable observations.
    Flag any points you are uncertain about rather than guessing.
