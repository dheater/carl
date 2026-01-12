#!/usr/bin/env bash
# Carl installation script
# Symlinks individual Carl rules to ~/.augment/rules/
# Symlinks carl binary to ~/.local/bin/

set -euo pipefail

# Use script location as CARL_DIR
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARL_RULES_DIR="$SCRIPT_DIR/rules"
CARL_BIN="$SCRIPT_DIR/zig-out/bin/carl"
AUGMENT_RULES_DIR="$HOME/.augment/rules"
LOCAL_BIN_DIR="$HOME/.local/bin"

echo "Installing Carl from: $SCRIPT_DIR"

# Check if ~/.augment/rules exists
if [ ! -d "$AUGMENT_RULES_DIR" ]; then
    echo "Error: ~/.augment/rules directory not found"
    echo "Please ensure Augment is installed first"
    exit 1
fi

# Check if Carl rules directory exists
if [ ! -d "$CARL_RULES_DIR" ]; then
    echo "Error: $CARL_RULES_DIR directory not found"
    echo "Carl installation appears incomplete"
    exit 1
fi

# Check if carl binary exists
if [ ! -f "$CARL_BIN" ]; then
    echo "Warning: $CARL_BIN not found"
    echo "Run 'devbox run build' to build the carl binary"
    echo "Continuing with rules installation only..."
fi

# Create ~/.local/bin if it doesn't exist
if [ ! -d "$LOCAL_BIN_DIR" ]; then
    mkdir -p "$LOCAL_BIN_DIR"
    echo "Created $LOCAL_BIN_DIR"
fi

# Symlink carl binary
if [ -f "$CARL_BIN" ]; then
    echo "Installing carl binary to ~/.local/bin/..."
    if [ -L "$LOCAL_BIN_DIR/carl" ]; then
        rm "$LOCAL_BIN_DIR/carl"
    fi
    ln -s "$CARL_BIN" "$LOCAL_BIN_DIR/carl"
    echo "  ✓ carl binary"
fi

# Symlink individual rule files
echo "Symlinking Carl rules to ~/.augment/rules/..."
for rule_file in "$CARL_RULES_DIR"/*.md; do
    if [ -f "$rule_file" ]; then
        rule_name=$(basename "$rule_file")
        target="$AUGMENT_RULES_DIR/$rule_name"

        # Remove existing symlink if it exists
        if [ -L "$target" ]; then
            rm "$target"
        fi

        # Create symlink
        ln -s "$rule_file" "$target"
        echo "  ✓ $rule_name"
    fi
done

echo ""
echo "✓ Carl installed successfully"
echo ""
if [ -f "$CARL_BIN" ]; then
    echo "Carl binary:"
    echo "  ~/.local/bin/carl"
    echo ""
    echo "Verify: carl check_all"
    echo ""
fi
echo "Carl rules:"
echo "  ~/.augment/rules/"
echo ""
echo "Rules will be automatically loaded by Augment AI."
echo ""
echo "Installation complete!"

