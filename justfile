home_dir := if env_var_or_default('HOME', '') != '' { env_var('HOME') } else { env_var('USERPROFILE') }
optimize := env_var_or_default('OPTIMIZE', 'Debug')

# Build carl
build:
    zig build -Doptimize={{optimize}}

# Run tests
test:
    zig build test

# Run carl with arguments
run *args:
    zig build run -- {{args}}

# Run all Carl checks against the current repo
check-all:
    zig build run -- check_all

# Copy Carl rules and skills into ~/.augment/rules/
sync-augment:
    zig build run -- sync_augment

# Install persona scripts to ~/.local/bin
install-personas:
    chmod +x bin/vera bin/dani bin/grey bin/lewis \
             bin/dani-research bin/dani-prd-to-plan bin/dani-prd \
             bin/dani-grill bin/dani-interface bin/dani-triage \
             bin/vera-prototype \
             bin/grey-commit bin/grey-qa \
             bin/lewis-jira bin/lewis-pr
    cp bin/vera bin/dani bin/grey bin/lewis \
       bin/dani-research bin/dani-prd-to-plan bin/dani-prd \
       bin/dani-grill bin/dani-interface bin/dani-triage \
       bin/vera-prototype \
       bin/grey-commit bin/grey-qa \
       bin/lewis-jira bin/lewis-pr \
       {{home_dir}}/.local/bin/

# Build and sync Carl into Augment
install: build sync-augment install-personas
