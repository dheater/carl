home_dir := if env_var_or_default('HOME', '') != '' { env_var('HOME') } else { env_var('USERPROFILE') }

# Build carl
build:
    npm run build

# Format the code
format:
    npx prettier --write "src/**/*.ts"


# Lint the code (type-check + formatting check, no extra dependencies)
lint:
	npx tsc --noEmit
	npx prettier --check "src/**/*.ts"


# Run tests
test:
    npm test

# Run carl with arguments
run *args:
    npm start -- {{args}}

# Build and install carl CLI to ~/.local/bin
install: build
    @echo '#!/usr/bin/env bash' > {{home_dir}}/.local/bin/carl
    @echo 'exec node "'`pwd`'/dist/carl.js" "$@"' >> {{home_dir}}/.local/bin/carl
    @chmod +x {{home_dir}}/.local/bin/carl
