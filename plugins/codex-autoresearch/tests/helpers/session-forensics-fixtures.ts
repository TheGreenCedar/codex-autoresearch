type RolloutEntry = Record<string, unknown>;

export function fixtureJsonl(entries: RolloutEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

export function benchmarkContractFixtureEntries(): RolloutEntry[] {
  return [
    { timestamp: "2026-06-01T13:02:13.000Z", type: "session_meta", payload: { id: "019e8346" } },
    {
      timestamp: "2026-06-01T13:10:26.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "benchmark-lint timed out after 60s and parses zero primary METRIC lines. The scorer works, but the wrapper is too expensive for the benchmark contract, so run next packet is unsafe.",
          },
        ],
      },
    },
  ];
}

export function benchmarkOverfitFixtureEntries(): RolloutEntry[] {
  return [
    { timestamp: "2026-06-11T20:24:14.000Z", type: "session_meta", payload: { id: "019eb85a" } },
    {
      timestamp: "2026-06-12T22:40:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "The harness work is mostly generalizable; the CodeStory wins are substantially overfit.",
              "The targeted row wins are benchmark-specific retrieval steering through task-family detectors, protected probes, and static citations.",
              "Treat them as diagnostic row repair until a blind holdout proves broader value.",
            ].join(" "),
          },
        ],
      },
    },
  ];
}

export function searchLatencyFixtureEntries(): RolloutEntry[] {
  return [
    { timestamp: "2026-05-31T20:00:00.000Z", type: "session_meta", payload: { id: "019e5d3a" } },
    {
      timestamp: "2026-05-31T20:04:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Packet quality is strong; wall time is dominated by the initial packet retrieval/search step. The next experiment should isolate search latency before another broad packet.",
          },
        ],
      },
    },
  ];
}

export function outputBudgetFixtureEntries(): RolloutEntry[] {
  return [
    { timestamp: "2026-05-31T21:00:00.000Z", type: "session_meta", payload: { id: "budget" } },
    {
      timestamp: "2026-05-31T21:00:30.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "There were too many small probes, but command output volume is now the blocker.",
          },
        ],
      },
    },
    {
      timestamp: "2026-05-31T21:01:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "rg -n important artifacts target logs" }),
      },
    },
    {
      timestamp: "2026-05-31T21:02:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_budget",
        output:
          "Original token count: 28000\nTotal output lines: 900\nOutput:\n<bounded fixture output omitted>",
      },
    },
    {
      timestamp: "2026-05-31T21:03:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "rg -n important artifacts target logs" }),
      },
    },
    {
      timestamp: "2026-05-31T21:04:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "rg -n important artifacts target logs" }),
      },
    },
  ];
}
