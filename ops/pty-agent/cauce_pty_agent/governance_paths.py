from __future__ import annotations

import hashlib
import os
import re
import stat
from typing import Any

# --- Reading governance files ----------------------------------------------------------------
#
# The bundle carries harness, HOME, and the measured overrides the agent publishes in AGENT_HELLO.
# Directory reads accept ONLY the memory root derived from those same facts; the sensitive names
# below are defence in depth, never the source of authorisation. Profile documents use their own
# closed set per harness. Neither path follows symlinks nor leaves the alias HOME.
FEATURES = (
    "read_governance", "write_governance_v1", "write_governance_batch_v1",
    "session_output_flow_control", "read_governance_done_v1",
)

# Never served or listed, wherever they live. Mirror of NEVER_SERVE_BASENAMES in the gateway
# (`services/gateway/src/console/agent-documents.ts`): the two lists defend separately on purpose,
# because a failure in only one must not be enough to leak a credential.
NEVER_SERVE_BASENAMES = frozenset({
    ".credentials.json", "auth.json", ".claude.json", "openclaw.json", ".env", ".netrc",
    "id_ed25519", "id_rsa", "known_hosts", "authorized_keys",
})
NEVER_SERVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx")

READ_KINDS = ("file", "dir")
MAX_READ_PATH = 4096
# 256 KB: the largest CLAUDE.md measured in the fleet is zeus's (10733 B) and hermes's AGENTS.md
# reaches 75 KB. Margin remains without turning the channel into a dump pipe.
MAX_DOCUMENT_BYTES = 256 * 1024
MAX_WRITE_TRANSACTIONS = 4
MAX_WRITE_BATCH_FILES = 7
MAX_WRITE_BATCH_BYTES = MAX_DOCUMENT_BYTES
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Memory index: metadata only, never content.
MAX_DIR_ENTRIES = 200
MAX_DIR_DEPTH = 3
DIR_SCAN_CAP = 5000
# Byte budget for index entries inside their SINGLE frame (MAX_FRAME = 64 KiB).
READ_INDEX_BUDGET = 48 * 1024


PROJECT_DOC_MAX_BYTES_LIMIT = 16 * 1024 * 1024
PROJECT_DOC_FALLBACK_LIMIT = 16


class ReadSymlinkError(OSError):
    """A requested READ path became, or already was, a symbolic link."""


class ReadPathTypeError(OSError):
    """A requested READ component exists but is not the required filesystem type."""


UNSAFE_TEXT_CODE_POINT_RANGES = (
    (0x00, 0x1F), (0x7F, 0x9F), (0x61C, 0x61C), (0x200B, 0x200F),
    (0x2028, 0x202E), (0x2060, 0x206F), (0xFEFF, 0xFEFF), (0xFFF9, 0xFFFB),
)


def _has_unsafe_text_code_point(value: str) -> bool:
    return any(lower <= code <= upper for code in map(ord, value)
               for lower, upper in UNSAFE_TEXT_CODE_POINT_RANGES)


def _valid_project_doc_fallback(value: Any, seen: set[str] | None = None) -> bool:
    """A Codex fallback is one bounded basename, never a path or credential-shaped file."""
    if not isinstance(value, str) or not value:
        return False
    try:
        # JavaScript's String.length counts UTF-16 code units. Match the gateway exactly so a
        # fallback cannot be accepted by one leg and silently dropped by the next.
        js_length = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return False
    if js_length > 128:
        return False
    if value in (".", "..") or ".." in value or "/" in value or "\\" in value or "\0" in value:
        return False
    if _has_unsafe_text_code_point(value):
        return False
    normalized = value.casefold()
    if normalized in NEVER_SERVE_BASENAMES or normalized.endswith(NEVER_SERVE_SUFFIXES):
        return False
    if seen is not None and normalized in seen:
        return False
    return True


class GovernancePathsMixin:
    def _profile_governance_file_paths(self) -> frozenset[str]:
        """Exact profile roots. These remain the only writable governance destinations."""
        harness = self.bundle.get("harness")
        facts = self.bundle.get("runtime_facts", {})
        home = str(self.bundle["home"]).rstrip("/")
        # HOME and the configured harness are container identity, not proof that the adapter was
        # alive.  Recovery shells intentionally start with `{}` facts; in that state no profile,
        # memory or manual path may be inferred from conventional defaults.
        if not isinstance(facts, dict) or not facts:
            return frozenset()
        if harness == "openclaw":
            root = facts.get("openclaw_workspace")
            allowed = {"SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"}
        elif harness == "claude":
            root = facts.get("claude_config_dir")
            allowed = {"CLAUDE.md"}
        elif harness == "codex":
            root = facts.get("codex_home")
            allowed = {"AGENTS.md"}
        elif harness == "hermes":
            root = home
            allowed = {"AGENTS.md"}
        else:
            return frozenset()
        if not isinstance(root, str):
            return frozenset()
        return frozenset(f"{root.rstrip('/')}/{name}" for name in allowed)

    def _readable_global_governance_file_paths(self) -> frozenset[str]:
        paths = set(self._profile_governance_file_paths())
        if self.bundle.get("harness") == "codex":
            facts = self.bundle.get("runtime_facts", {})
            root = facts.get("codex_home") if isinstance(facts, dict) else None
            if isinstance(root, str):
                paths.add(f"{root.rstrip('/')}/AGENTS.override.md")
        return frozenset(paths)

    def _project_manual_paths(self) -> tuple[str, ...]:
        """Project manuals in effective precedence order, derived only from measured facts.

        With an accredited workspace root, every directory from root to cwd participates. Without
        one, cwd itself is still a real `/proc` measurement and authorizes exactly one level; the
        agent never walks towards `/` looking for a plausible repository root.
        """
        harness = self.bundle.get("harness")
        if harness not in ("claude", "codex"):
            return ()
        facts = self.bundle.get("runtime_facts", {})
        if not isinstance(facts, dict):
            return ()
        codex_fallbacks: tuple[str, ...] = ()
        if harness == "codex":
            raw_fallbacks = facts.get("project_doc_fallback_filenames")
            if isinstance(raw_fallbacks, list) and len(raw_fallbacks) <= PROJECT_DOC_FALLBACK_LIMIT:
                accepted: list[str] = []
                seen = {"AGENTS.override.md", "AGENTS.md"}
                for name in raw_fallbacks:
                    if not _valid_project_doc_fallback(name, seen):
                        accepted = []
                        break
                    seen.add(name)
                    accepted.append(name)
                codex_fallbacks = tuple(accepted)
        cwd = facts.get("cwd")
        # Both runtimes start at the measured project marker. A workspace mount can contain
        # several repositories and its top-level manual need not govern the current process.
        root = facts.get("project_root")
        if not isinstance(cwd, str) or not self._canonical_context_directory(cwd):
            return ()
        directories: list[str]
        if root is None:
            directories = [cwd]
        else:
            if not isinstance(root, str) or not self._canonical_context_directory(root):
                return ()
            try:
                if os.path.commonpath((root, cwd)) != root:
                    return ()
                relative = os.path.relpath(cwd, root)
            except ValueError:
                return ()
            parts = [] if relative == "." else relative.split(os.sep)
            # A measured context this deep is not operationally useful and would amplify one READ
            # into an unbounded sequence. Fail closed instead of silently dropping ancestors.
            if len(parts) > 64 or any(part in ("", ".", "..") for part in parts):
                return ()
            directories = [root]
            current = root
            for part in parts:
                current = f"{current.rstrip('/')}/{part}"
                directories.append(current)
        paths: list[str] = []
        for directory in directories:
            root = directory.rstrip("/")
            if harness == "claude":
                paths.extend((
                    f"{root}/CLAUDE.md", f"{root}/.claude/CLAUDE.md",
                    f"{root}/CLAUDE.local.md",
                ))
            else:
                paths.extend((
                    f"{root}/AGENTS.override.md", f"{root}/AGENTS.md",
                    *(f"{root}/{fallback}" for fallback in codex_fallbacks),
                ))
        return tuple(paths)

    @staticmethod
    def _canonical_context_directory(path: str) -> bool:
        if not path.startswith("/") or path == "/" or len(path) > MAX_READ_PATH or "\0" in path:
            return False
        segments = path.split("/")
        return os.path.normpath(path) == path \
            and not any(segment in ("", ".", "..") for segment in segments[1:])

    def _is_project_manual_path(self, path: str) -> bool:
        return path in self._project_manual_paths()

    def _is_readable_governance_file_path(self, path: str) -> bool:
        return path in self._readable_global_governance_file_paths() or self._is_project_manual_path(path)

    def _is_writable_governance_file_path(self, path: str) -> bool:
        return path in self._profile_governance_file_paths()

    def _memory_root_for_harness(self) -> str | None:
        """Exact root mirrored by the gateway from the facts published in AGENT_HELLO."""
        harness = self.bundle.get("harness")
        facts = self.bundle.get("runtime_facts", {})
        home = str(self.bundle.get("home", "")).rstrip("/")
        if not home.startswith("/") or not isinstance(facts, dict) or not facts:
            return None
        if harness == "claude":
            base = facts.get("claude_config_dir")
            leaf = "projects"
        elif harness == "codex":
            base = facts.get("codex_home")
            leaf = "memories"
        elif harness == "openclaw":
            base = facts.get("openclaw_workspace")
            leaf = "memory"
        else:
            return None
        if not isinstance(base, str) or not base.startswith("/"):
            return None
        return f"{base.rstrip('/')}/{leaf}"

    @staticmethod
    def _safe_memory_entry_name(name: str) -> bool:
        if not name or name in (".", "..") or "/" in name or "\0" in name:
            return False
        if _has_unsafe_text_code_point(name):
            return False
        try:
            name.encode("utf-8")
        except UnicodeEncodeError:
            return False
        return True

    @staticmethod
    def _classify_directory_open_error(directory: int, segment: str, error: OSError) -> None:
        """Translate a no-follow open failure without trusting a preflight stat."""
        try:
            details = os.stat(segment, dir_fd=directory, follow_symlinks=False)
        except OSError:
            raise
        if stat.S_ISLNK(details.st_mode):
            raise ReadSymlinkError(segment) from None
        if not stat.S_ISDIR(details.st_mode):
            raise ReadPathTypeError(segment) from None
        raise error

    @staticmethod
    def _open_memory_directory_at(directory: int, segment: str) -> int:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            child = os.open(segment, flags, dir_fd=directory)
        except OSError as error:
            GovernancePathsMixin._classify_directory_open_error(directory, segment, error)
            raise AssertionError("directory open classifier returned") from error
        if not stat.S_ISDIR(os.fstat(child).st_mode):
            os.close(child)
            raise ReadPathTypeError(segment)
        return child

    @staticmethod
    def _memory_regular_stat_at(directory: int, basename: str) -> os.stat_result | None:
        # O_PATH obtains metadata without opening content (or activating devices/FIFOs if the
        # name was swapped after lstat). With O_NOFOLLOW, a swap to symlink produces an fd on
        # the link itself and fstat rejects it below.
        flags = getattr(os, "O_PATH", os.O_RDONLY | os.O_NONBLOCK)
        flags |= os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            descriptor = os.open(basename, flags, dir_fd=directory)
        except OSError:
            return None
        try:
            details = os.fstat(descriptor)
            return details if stat.S_ISREG(details.st_mode) else None
        finally:
            os.close(descriptor)

    def _open_memory_root(self, root: str) -> int:
        """Open the authorized memory root using only fd-relative no-follow traversal."""
        home = str(self.bundle["home"]).rstrip("/") or "/"
        if home == "/" or not root.startswith(home + "/"):
            raise PermissionError("memory root is outside HOME")
        relative = root[len(home) + 1:].split("/")
        # HOME is also walked from `/` with openat: O_NOFOLLOW on an absolute path only protects
        # its last component and could follow a symlink at any parent.
        directory = self._open_absolute_memory_directory(home)
        try:
            for segment in relative:
                child = self._open_memory_directory_at(directory, segment)
                os.close(directory)
                directory = child
            return directory
        except BaseException:
            os.close(directory)
            raise

    @classmethod
    def _open_absolute_memory_directory(cls, path: str) -> int:
        """Use `/` as trust anchor and reject symlinks in every absolute-path component."""
        if path == "/" or not path.startswith("/") or os.path.normpath(path) != path:
            raise ReadPathTypeError(path)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        directory = os.open("/", flags)
        try:
            for segment in path.split("/")[1:]:
                child = cls._open_memory_directory_at(directory, segment)
                os.close(directory)
                directory = child
            return directory
        except BaseException:
            os.close(directory)
            raise

    def _open_governance_parent(self, path: str) -> tuple[int, str]:
        """Abre cada padre con O_NOFOLLOW y devuelve `(dirfd, basename)`.

        Resolver con `realpath` y luego abrir por nombre deja una carrera entre ambos pasos. Esta
        caminata queda anclada en descriptores: cambiar un padre por un enlace no redirige la E/S.
        """
        parent, basename = os.path.split(path)
        if not parent or not basename or os.path.normpath(path) != path:
            raise ReadPathTypeError(path)
        # Anchor at `/` and reject symlinks component-by-component. Project manuals legitimately
        # live outside HOME; exact-path authorization happened before this routine is reached.
        directory = self._open_absolute_memory_directory(parent)
        return directory, basename

    @staticmethod
    def _hash_regular_at(directory: int, basename: str) -> tuple[str, os.stat_result]:
        fd = os.open(basename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise PermissionError("governance target is not a regular file")
            digest = hashlib.sha256()
            while True:
                chunk = os.read(fd, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            after = os.fstat(fd)
            identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            if identity_before != identity_after:
                raise ValueError("the file changed while its precondition was checked")
            return digest.hexdigest(), after
        finally:
            os.close(fd)

    @staticmethod
    def _stat_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
