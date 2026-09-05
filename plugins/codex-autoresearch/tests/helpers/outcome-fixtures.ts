export function governedFixture(cwd: string) {
  return {
    id: "investigation",
    objective: "Establish compatibility",
    criteria: [
      {
        id: "compatibility",
        description: "The fixture is compatible",
        authority: "internal",
        subject: "candidate",
      },
    ],
    authorization: {
      reference: "user-accepted",
      worktrees: [cwd],
      editable: ["src"],
      protected: ["checks"],
      effects: ["inspect", "edit", "execute"],
      environments: ["local"],
      delivery: "patch",
    },
    budget: { actions: 5, executionSeconds: 120 },
  };
}

export function actionFixture(id: string) {
  return {
    id,
    investigation: {
      id: "H1",
      question: "Does the fixture preserve compatibility?",
      intervention: "Inspect the compatibility example",
      distinguishingObservations: ["matching output", "counterexample"],
      evidenceRefs: [],
      retryAllowance: 1,
    },
    purpose: "experiment",
    effects: ["inspect"],
    paths: [],
    environment: "local",
    seconds: 10,
    mode: "managed",
    argv: [],
    evidenceRefs: [],
    evaluator: {
      id: "compatibility-v1",
      criterionIds: ["compatibility"],
      environment: "local",
      method: { kind: "predicate" },
      repeats: 1,
      argv: [],
      checkArgv: [],
    },
  };
}
