export default {
  id: "hospital-muse-native",
  name: "Hospital Muse native CLI backend",
  register(api) {
    api.registerCliBackend({
      id: "muse-cli",
      ownsNativeCompaction: true,
      config: {
        command: "/usr/bin/python3",
        args: ["/home/node/clawd/.cauce/runtime/muse-cli-backend.py"],
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
