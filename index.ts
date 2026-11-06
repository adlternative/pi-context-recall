import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    // Read live state per call: /tree can move the leaf without changing the session file.
    const file = ctx.sessionManager.getSessionFile() ?? "";
    const leaf = ctx.sessionManager.getLeafId() ?? "";
    event.input.command =
      `export PI_CONTEXT_RECALL_SESSION=${quote(file)} PI_CONTEXT_RECALL_LEAF=${quote(leaf)};\n` +
      event.input.command;
  });
}
