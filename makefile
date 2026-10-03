.PHONY: serve static install sync update test test-browser

serve:
	python3 studio/server.py --port 1313

static:
	python3 -m http.server --directory site 1315

install:
	bun install
	bunx playwright install chromium
	$(MAKE) sync

# Recursively copy the locked Three.js entry points and all of their relative
# imports. Published work snapshots vendor/, so node_modules never reaches deploys.
sync:
	bun run sync:vendor

# Deliberately move to current releases, refresh Chromium, synchronize the
# offline runtime, and refuse to succeed unless the complete suite passes.
update:
	bun add --exact three@latest
	bun add --dev --exact playwright@latest
	bunx playwright install chromium
	$(MAKE) sync
	$(MAKE) test

test:
	bun run test

test-browser:
	bun run test:browser
