home_dir := if env_var_or_default('HOME', '') != '' { env_var('HOME') } else { env_var('USERPROFILE') }

# Build carl
build:
    npm run build

# Run tests
test:
    npm test

# Run carl with arguments
run *args:
    npm start -- {{args}}

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

# Build carl and install personas
install: build install-personas
