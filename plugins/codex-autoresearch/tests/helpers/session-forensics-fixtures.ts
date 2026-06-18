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

export function codeStoryLanguageSupportFrictionFixtureEntries(): RolloutEntry[] {
  return [
    {
      timestamp: "2026-06-16T14:00:00.000Z",
      type: "session_meta",
      payload: { id: "019f-language-support" },
    },
    {
      timestamp: "2026-06-16T14:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I created the Autoresearch scaffold for CodeStory language support, but I have not started the measured loop yet.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-16T14:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Setup alone is not autoresearch. The loop did not start, so stop calling this progress.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-16T14:03:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Do not rerun the no-CodeStory baseline; reuse the fixed control artifact from the first run.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-16T14:04:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I picked up an old segment from the stale segment state, then completed the Codex goal.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-16T14:05:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "That fix is hard-coded and overfit to filenames, with repo-specific assumption and answer-key steering.",
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

export function session019eb85aControlPlaneFixtureEntries(): RolloutEntry[] {
  return [
    { timestamp: "2026-06-12T18:00:00.000Z", type: "session_meta", payload: { id: "019eb85a" } },
    {
      timestamp: "2026-06-12T18:05:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Implemented the review remediation pass and finalized all issues.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-12T18:06:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "This is not done; impossible that you solved it that fast. I approved that earlier and the approval loop stalled and wasted my whole night.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-12T18:07:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_goal_contract",
        output:
          'Original token count: 28000\nTotal output lines: 1400\n{"goalFrame":{"codexObjectiveRole":"missing"}}',
      },
    },
    {
      timestamp: "2026-06-12T18:08:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "RAM and CPU hit 100% and I had to reboot after repeated process-manager polling.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-12T18:09:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I did not push anything; the finalization branches are local only.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-12T18:10:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Cleanup after the fact: deleted worktree and remove branch entries after verification.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-12T18:11:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "The wins are overfit to row-specific detectors, protected probes, static citations, and answer-key steering; treat them as diagnostic until holdout proof exists.",
          },
        ],
      },
    },
  ];
}
