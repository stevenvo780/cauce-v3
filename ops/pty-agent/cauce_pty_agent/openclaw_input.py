from __future__ import annotations


class OpenClawInput:
    """Preserve repeated Backspace events across OpenClaw's time-based input deduper.

    Its editor maps Shift+Backspace to the same deletion, without deduplicating it. Explicit
    CSI-u framing survives coalesced network reads; pacing bytes would queue stale keystrokes.
    Escape sequences and bracketed paste pass through, including across input frames.
    """

    def __init__(self) -> None:
        self.state = "text"
        self.marker = b""

    def translate(self, data: bytes) -> bytes:
        output = bytearray()
        for byte in data:
            output.extend(b"\x1b[127;2u" if self.state == "text" and byte == 127 else bytes([byte]))
            if self.state == "paste":
                candidate = self.marker + bytes([byte])
                self.marker = candidate if b"\x1b[201~".startswith(candidate) else b"\x1b" if byte == 27 else b""
                if self.marker == b"\x1b[201~":
                    self.state, self.marker = "text", b""
            elif self.state == "text":
                if byte == 27:
                    self.state = "escape"
            elif self.state == "escape":
                if byte == ord("["):
                    self.state, self.marker = "csi", b"\x1b["
                elif byte in b"]P^_X":
                    self.state = "string"
                elif byte != 27 and not 32 <= byte <= 47:
                    self.state = "text"
            elif self.state == "csi":
                candidate = self.marker + bytes([byte])
                self.marker = candidate if self.marker and b"\x1b[200~".startswith(candidate) else b""
                if 64 <= byte <= 126:
                    self.state = "paste" if self.marker == b"\x1b[200~" else "text"
                    self.marker = b""
            elif self.state == "string":
                if byte == 7 or self.marker == b"\x1b" and byte == ord("\\"):
                    self.state = "text"
                self.marker = b"\x1b" if byte == 27 else b""
        return bytes(output)
