let body = "";
process.stdin.on("data", (chunk) => {
  body += chunk.toString();
});
process.stdin.on("end", () => {
  const request = JSON.parse(body);

  if (request.phase === "plan") {
    process.stdout.write(JSON.stringify({ summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] }));
    return;
  }

  if (request.phase === "execute") {
    if (typeof request.partialOutcomeRecoveryWindowMs !== "number") {
      process.stderr.write("missing partialOutcomeRecoveryWindowMs");
      process.exit(1);
    }

    if (request.runDir.includes("partial")) {
      process.stdout.write(
        JSON.stringify({
          completionStatus: "partial",
          failureType: "timeout",
          failureMessage: "subprocess timed out",
          changedFiles: ["secret.txt"],
          diffPatch: "diff --git a/secret.txt b/secret.txt",
          commandOutputs: [request.worktreePath],
          stdoutStderrLog: "timed out",
        }),
      );
      return;
    }

    process.stdout.write(
      JSON.stringify({
        changedFiles: ["src/index.ts"],
        diffPatch: "diff --git a/src/index.ts b/src/index.ts",
        commandOutputs: [request.worktreePath],
        stdoutStderrLog: "ok",
      }),
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      approved: true,
      rejectCategory: "",
      primaryTargetPaths: ["src/index.ts"],
      failingCommand: null,
      safeToRetry: false,
      evidence: ["npm test passed"],
      pauseSignals: [],
      stopSignals: [],
    }),
  );
});
