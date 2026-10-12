// The Muse fallback runs with the operator's uid inside the operator container, so it can read the operator
// PKI and ~/.openclaw. It stays off unless the container is created with this exact opt-in.
const OPERATOR_MUSE_FALLBACK_FLAG = "CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK";
// Installed root:root and mounted read-only; -I ignores PYTHON* variables, user site and the script directory.
const TRUSTED_BACKEND = "/opt/cauce-hospital/runtime/muse-cli-backend.py";

export default {
  id: "hospital-muse-native",
  name: "Hospital Muse native CLI backend",
  register(api) {
    if (process.env[OPERATOR_MUSE_FALLBACK_FLAG] !== "1") return;
    api.registerCliBackend({
      id: "muse-cli",
      ownsNativeCompaction: true,
      config: {
        command: "/usr/bin/python3",
        args: ["-I", "-B", TRUSTED_BACKEND],
        output: "jsonl",
        input: "stdin",
        sessionArg: "--session-id",
        sessionMode: "existing",
        sessionIdFields: ["session_id"],
        systemPromptArg: "--system-prompt",
        systemPromptMode: "append",
        systemPromptWhen: "always",
        serialize: true,
      },
    });
  },
};
