#!/bin/bash
set -e -o pipefail

# ──────────────────────────────────────────────────────────────
#  CodeRadius CLI — Universal Installer
#  Usage: curl -fsSL https://raw.githubusercontent.com/coderadius-ai/coderadius/main/scripts/install.sh | bash
#
#  Downloads the prebuilt binary from GitHub Releases and installs
#  (user-owned, no sudo) to:
#    $HOME/.coderadius/lib/cr          (binary + node_modules)
#    $HOME/.coderadius/bin/cr          (wrapper script, added to PATH)
#
#  Override the install root with CR_INSTALL_DIR=/custom/path.
#  Pin a version with CR_VERSION=v0.2.0 (defaults to the latest release).
# ──────────────────────────────────────────────────────────────

REPO="coderadius-ai/coderadius"
BIN_NAME="cr"
INSTALL_ROOT="${CR_INSTALL_DIR:-$HOME/.coderadius}"
LIB_DIR="${INSTALL_ROOT}/lib"   # binary + node_modules live here (hidden from user)
BIN_DIR="${INSTALL_ROOT}/bin"   # wrapper script goes here, added to PATH

# ── Colours ──────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()    { echo -e "  ${CYAN}→${RESET}  $*"; }
success() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $*"; }
die()     { echo -e "  ${RED}✗${RESET}  $*" >&2; exit 1; }

# ── LOGO START ──
echo -e "${CYAN}  ⠀⠀⢀⣤⣤⣦⣤⣄⠀⠀  ${RESET}"
echo -e "${CYAN}  ⠀⣴⣿⣿⣿⣿⣿⡿⢋⡄  ${RESET}"
echo -e "${CYAN}  ⠠⣿⣿⣿⠁⠀⢠⣾⣿⣿⠄ ${RESET}  ${BOLD}CodeRadius CLI — Installer${RESET}"
echo -e "${CYAN}  ⠀⢿⣿⣿⣷⣶⣿⣿⣿⠇  ${RESET}"
echo -e "${CYAN}  ⠀⠀⠙⠿⠿⡿⠿⠟⠁⠀  ${RESET}"
# ── LOGO END ──
echo ""

# ── 1. Detect OS ─────────────────────────────────────────────
OS="$(uname -s)"
case "${OS}" in
    Linux*)   OS_KEY="linux"  ;;
    Darwin*)  OS_KEY="darwin" ;;
    *)        die "Unsupported OS: ${OS}. Only Linux and macOS are supported." ;;
esac

# ── 2. Detect Architecture ───────────────────────────────────
ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64 | amd64)   ARCH_KEY="amd64" ;;
    arm64  | aarch64) ARCH_KEY="arm64" ;;
    *)                die "Unsupported architecture: ${ARCH}." ;;
esac

info "Detected platform: ${OS_KEY}/${ARCH_KEY}"

# ── 3. Resolve version ───────────────────────────────────────
VERSION="${CR_VERSION:-}"
if [ -z "$VERSION" ]; then
    info "Resolving latest release..."
    VERSION=$(curl -sL --fail "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[^"]*"([^"]+)".*/\1/')
fi
if [ -z "$VERSION" ]; then
    die "Could not resolve the latest release from github.com/${REPO}.\n     (GitHub's unauthenticated API allows 60 requests/hour per IP; you may be rate-limited.)\n     Pin a version explicitly: CR_VERSION=v0.2.0"
fi
info "Version: ${BOLD}${VERSION}${RESET}"

# ── 4. Download tarball ──────────────────────────────────────
TARBALL="coderadius_${OS_KEY}_${ARCH_KEY}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"
TMP_DIR=$(mktemp -d)
trap "rm -rf '${TMP_DIR}'" EXIT   # always cleanup on exit

info "Downloading ${TARBALL}..."
if ! curl -sL --fail "${DOWNLOAD_URL}" -o "${TMP_DIR}/${TARBALL}"; then
    die "Download failed: ${DOWNLOAD_URL}\nCheck that version ${VERSION} has a build for ${OS_KEY}/${ARCH_KEY}."
fi

# ── 5. Verify Checksum ───────────────────────────────────────
info "Verifying checksum..."
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"
if ! curl -sL --fail "${CHECKSUM_URL}" -o "${TMP_DIR}/${TARBALL}.sha256"; then
    die "Failed to download checksum file: ${CHECKSUM_URL}"
fi

if command -v shasum &>/dev/null; then
    SHA256_CMD="shasum -a 256"
elif command -v sha256sum &>/dev/null; then
    SHA256_CMD="sha256sum"
else
    die "Neither shasum nor sha256sum found. Cannot verify checksum."
fi

(cd "${TMP_DIR}" && ${SHA256_CMD} -c "${TARBALL}.sha256" >/dev/null) || die "Checksum verification failed! The downloaded archive may be corrupted or compromised."
success "Checksum verified successfully."

# ── 6. Extract ───────────────────────────────────────────────
info "Extracting..."
tar -xzf "${TMP_DIR}/${TARBALL}" -C "${TMP_DIR}"

if [ ! -f "${TMP_DIR}/${BIN_NAME}" ]; then
    die "Binary '${BIN_NAME}' not found inside tarball. Expected tarball to contain: cr, node_modules/"
fi
chmod +x "${TMP_DIR}/${BIN_NAME}"

# ── 7. Install (binary + native deps into lib dir) ───────────
# The SEA binary resolves native node_modules via createRequire(process.execPath),
# so node_modules must live next to the binary, in the lib dir.
# The user only sees the wrapper at ${BIN_DIR}/cr.
info "Installing to ${INSTALL_ROOT}..."

# Verify the install root is writable. We never auto-escalate to sudo:
# if the user picked a system path via CR_INSTALL_DIR, fail loud and let
# them re-run with the default user-owned location.
if ! mkdir -p "${LIB_DIR}" "${BIN_DIR}" 2>/dev/null; then
    if [ "${INSTALL_ROOT}" = "${HOME}/.coderadius" ]; then
        die "Cannot create ${INSTALL_ROOT}. Check that \$HOME is writable."
    else
        die "Cannot write to ${INSTALL_ROOT}.\n     Re-run without CR_INSTALL_DIR to install under \$HOME/.coderadius (no sudo needed)."
    fi
fi

mv "${TMP_DIR}/${BIN_NAME}" "${LIB_DIR}/${BIN_NAME}"

# Move native deps alongside the binary
if [ -d "${TMP_DIR}/node_modules" ]; then
    rm -rf "${LIB_DIR}/node_modules"
    mv "${TMP_DIR}/node_modules" "${LIB_DIR}/node_modules"
fi

# ── 8. Create Wrapper Script in PATH ────────────────────────────
info "Creating wrapper script at ${BIN_DIR}/${BIN_NAME}..."
# We create a wrapper instead of a symlink to inject NODE_PATH.
# Bun's standalone binaries compiled with --external currently resolve
# native dependencies relative to CWD instead of the real executable path.
WRAPPER_SCRIPT="#!/bin/sh
export NODE_PATH=\"${LIB_DIR}/node_modules\${NODE_PATH:+:\$NODE_PATH}\"
exec \"${LIB_DIR}/${BIN_NAME}\" \"\$@\""

if [ -L "${BIN_DIR}/${BIN_NAME}" ] || [ -e "${BIN_DIR}/${BIN_NAME}" ]; then
    rm -f "${BIN_DIR}/${BIN_NAME}"
fi
echo "$WRAPPER_SCRIPT" > "${BIN_DIR}/${BIN_NAME}"
chmod +x "${BIN_DIR}/${BIN_NAME}"

# ── 9. Update PATH in shell rc files ─────────────────────────
# Idempotent append delimited by markers (rustup / conda style).
ensure_path_in_rc() {
    rc_file="$1"
    [ -f "$rc_file" ] || return 0
    grep -q '# >>> coderadius initialize >>>' "$rc_file" 2>/dev/null && return 0
    {
        printf '\n# >>> coderadius initialize >>>\n'
        printf 'export PATH="%s:$PATH"\n' "${BIN_DIR}"
        printf '# <<< coderadius initialize <<<\n'
    } >> "$rc_file"
    info "Added ${BIN_DIR} to PATH in ${rc_file}"
}

# Skip rc updates entirely when BIN_DIR is already on PATH (custom prefix
# already covered, e.g. /usr/local/bin) or when the user opted out.
case ":${PATH}:" in
    *":${BIN_DIR}:"*) PATH_ALREADY_SET=1 ;;
    *)                PATH_ALREADY_SET=0 ;;
esac

if [ "$PATH_ALREADY_SET" = "0" ]; then
    ensure_path_in_rc "$HOME/.zshrc"
    ensure_path_in_rc "$HOME/.bashrc"
    ensure_path_in_rc "$HOME/.bash_profile"
    ensure_path_in_rc "$HOME/.profile"
fi

# ── 10. Legacy install warning ───────────────────────────────
LEGACY_LIB="/usr/local/lib/coderadius"
LEGACY_BIN="/usr/local/bin/${BIN_NAME}"
if [ -d "$LEGACY_LIB" ] || { [ -e "$LEGACY_BIN" ] && [ "$LEGACY_BIN" != "${BIN_DIR}/${BIN_NAME}" ]; }; then
    echo ""
    warn "Found a previous system-wide install at ${LEGACY_LIB} / ${LEGACY_BIN}."
    warn "The new ${BIN_DIR}/${BIN_NAME} takes precedence via PATH. To remove the old copy, run:"
    echo -e "      ${CYAN}sudo rm -rf ${LEGACY_LIB} ${LEGACY_BIN}${RESET}"
fi

# ── 11. Verify ───────────────────────────────────────────────
# Test the wrapper directly: when running via `curl | bash`, the parent
# shell's PATH is not yet aware of BIN_DIR even after the rc update.
if "${BIN_DIR}/${BIN_NAME}" --version >/dev/null 2>&1; then
    success "CodeRadius ${VERSION} installed successfully!"
    if [ "$PATH_ALREADY_SET" = "0" ]; then
        echo ""
        info "Restart your terminal or run: ${BOLD}source ~/.zshrc${RESET} (or your shell's rc file)"
    fi
    echo ""
    echo -e "  ${BOLD}Get started:${RESET}"
    echo -e "    ${CYAN}cr init${RESET}                — Setup credentials & AI settings"
    echo -e "    ${CYAN}cr start${RESET}               — Launch infrastructure (Docker)"
    echo -e "    ${CYAN}cr ingest meta${RESET}         — Inventory repository context"
    echo -e "    ${CYAN}cr ui${RESET}                  — View architecture dashboard"
    echo -e "    ${CYAN}cr mcp configure${RESET}       — Connect with Cursor or Claude Desktop"
    echo ""
else
    die "Installed at ${BIN_DIR}/${BIN_NAME} but the binary failed to run. Please report this."
fi
