#!/usr/bin/env bash
# setup.sh -- One-command setup for Prompt Enhancer (macOS / Linux / WSL)
# Usage: ./setup.sh

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} Prompt Enhancer - Team Setup           ${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# -------------------------------------------------------------------------
# 1. Check Node.js >= 18
# -------------------------------------------------------------------------
echo -e "${YELLOW}[1/6] Checking Node.js...${NC}"
if ! command -v node &>/dev/null; then
    echo -e "${RED}  ERROR: Node.js not found. Install from https://nodejs.org/${NC}"
    exit 1
fi
NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}  ERROR: Node.js >= 18 required (found $NODE_VERSION).${NC}"
    exit 1
fi
echo -e "${GREEN}  OK: $NODE_VERSION${NC}"

# -------------------------------------------------------------------------
# 2. Install Cursor CLI (agent) if not present
# -------------------------------------------------------------------------
echo -e "${YELLOW}[2/6] Checking Cursor CLI (agent)...${NC}"
AGENT_CMD=""
if command -v agent &>/dev/null; then
    AGENT_CMD="agent"
elif [ -x "$HOME/.cursor/bin/agent" ]; then
    AGENT_CMD="$HOME/.cursor/bin/agent"
fi

if [ -n "$AGENT_CMD" ]; then
    AGENT_VER=$($AGENT_CMD --version 2>/dev/null || echo "unknown")
    echo -e "${GREEN}  OK: agent $AGENT_VER${NC}"
else
    echo -e "${YELLOW}  Cursor CLI not found. Installing...${NC}"
    if curl https://cursor.com/install -fsS | bash; then
        echo -e "${GREEN}  Installed successfully.${NC}"
        # Re-detect
        if command -v agent &>/dev/null; then
            AGENT_CMD="agent"
        elif [ -x "$HOME/.cursor/bin/agent" ]; then
            AGENT_CMD="$HOME/.cursor/bin/agent"
        fi
    else
        echo -e "${RED}  WARNING: Could not auto-install. Install manually:${NC}"
        echo -e "${RED}    curl https://cursor.com/install -fsS | bash${NC}"
        echo -e "${YELLOW}  Continuing without CLI (template fallback will be used)...${NC}"
    fi
fi

# -------------------------------------------------------------------------
# 3. Check Cursor CLI authentication
# -------------------------------------------------------------------------
echo -e "${YELLOW}[3/6] Checking Cursor CLI authentication...${NC}"
if [ -n "$AGENT_CMD" ]; then
    STATUS=$($AGENT_CMD status 2>&1 || true)
    if echo "$STATUS" | grep -qi "not logged in"; then
        echo -e "${YELLOW}  Cursor CLI is not logged in.${NC}"
        echo -e "${YELLOW}  Running 'agent login' -- a browser window will open.${NC}"
        echo ""
        $AGENT_CMD login || true
        echo ""
        # Verify
        STATUS2=$($AGENT_CMD status 2>&1 || true)
        if echo "$STATUS2" | grep -qi "not logged in"; then
            echo -e "${RED}  WARNING: Still not logged in. You can run 'agent login' later.${NC}"
        else
            echo -e "${GREEN}  Authenticated successfully.${NC}"
        fi
    else
        echo -e "${GREEN}  OK: Already authenticated.${NC}"
    fi
else
    echo -e "${YELLOW}  SKIP: Cursor CLI not available.${NC}"
fi

# -------------------------------------------------------------------------
# 4. Install npm dependencies
# -------------------------------------------------------------------------
echo -e "${YELLOW}[4/6] Installing npm dependencies...${NC}"
npm run setup
echo -e "${GREEN}  OK: Dependencies installed.${NC}"

# -------------------------------------------------------------------------
# 5. Build the VSIX package
# -------------------------------------------------------------------------
echo -e "${YELLOW}[5/6] Building VSIX package...${NC}"
npm run package
echo -e "${GREEN}  OK: VSIX built.${NC}"

# -------------------------------------------------------------------------
# 6. Install the extension into Cursor
# -------------------------------------------------------------------------
echo -e "${YELLOW}[6/6] Installing extension into Cursor...${NC}"
VSIX=$(ls -t build/*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
    echo -e "${RED}  ERROR: No .vsix file found in build/.${NC}"
    exit 1
fi

INSTALLED=false
if command -v cursor &>/dev/null; then
    if cursor --install-extension "$VSIX" --force 2>/dev/null; then
        INSTALLED=true
    fi
fi
if [ "$INSTALLED" = false ] && command -v code &>/dev/null; then
    if code --install-extension "$VSIX" --force 2>/dev/null; then
        INSTALLED=true
    fi
fi

if [ "$INSTALLED" = true ]; then
    echo -e "${GREEN}  OK: Extension installed ($(basename "$VSIX")).${NC}"
else
    echo -e "${YELLOW}  Could not auto-install. Install manually:${NC}"
    echo -e "${YELLOW}    1. Open Cursor/VS Code${NC}"
    echo -e "${YELLOW}    2. Cmd+Shift+P > 'Extensions: Install from VSIX...'${NC}"
    echo -e "${YELLOW}    3. Select: $VSIX${NC}"
fi

# -------------------------------------------------------------------------
# Done
# -------------------------------------------------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} Setup complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Next steps:${NC}"
echo "  1. Restart Cursor if it's running"
echo "  2. Open a project and try:"
echo "     - Ctrl+Shift+P > 'Prompt Enhancer: Open Panel'"
echo "     - Type '@enhance fix the login bug' in Chat"
echo "  3. (Optional) Set up the MCP server -- see README.md"
echo ""
