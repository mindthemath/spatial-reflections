.PHONY: serve static install sync update test test-python test-browser test-video-capture test-video-soak unstick

serve:
	python3 studio/server.py --port 1313

# When localhost:1313 spins and the server logs nothing, stop the wedged process.
unstick:
	scripts/unstick-server.sh

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

test-python:
	python3 -m unittest discover -s studio -p 'test_*.py'

# Opt-in production-resolution encoder test. Uses temporary storage, never overwrites source.
VIDEO_SOAK_SECONDS ?= 6
test-video-soak:
	python3 studio/video_soak.py --source "$(VIDEO_SOAK_SOURCE)" --seconds "$(VIDEO_SOAK_SECONDS)"

test-video-capture:
	node studio/test_video_capture.cjs

test-browser:
	bun run test:browser
