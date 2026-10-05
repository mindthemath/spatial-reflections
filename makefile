.PHONY: serve static install sync update test test-fast test-guard test-python test-browser test-video-capture test-video-encoder test-video-soak _test-all _test-browser unstick

TEST_GUARD = python3 scripts/test_guard.py

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

# Full validation is explicit and serialized. Prefer test-fast while editing.
test:
	$(TEST_GUARD) --network --timeout 600 -- $(MAKE) _test-all

_test-all:
	$(MAKE) test-fast
	$(MAKE) test-python
	$(MAKE) test-browser

# No browser, network server, real encoder, or production assets.
test-fast:
	bun run test:vendor
	bun run test:syntax
	node studio/test_resolution.cjs
	node studio/test_lifecycle_test.cjs
	node studio/test_skybox_hashing.cjs
	python3 -m unittest discover -s studio -p 'test_video_resume.py'
	$(MAKE) test-guard

test-guard:
	python3 -m unittest discover -s scripts -p 'test_test_guard.py'

test-python:
	$(TEST_GUARD) --network --timeout 180 -- python3 -m unittest discover -s studio -p 'test_*.py'

# Opt-in production-resolution encoder test. Uses temporary storage, never overwrites source.
VIDEO_SOAK_SECONDS ?= 6
test-video-soak:
	$(TEST_GUARD) --timeout 7200 -- python3 studio/video_soak.py --source "$(VIDEO_SOAK_SOURCE)" --seconds "$(VIDEO_SOAK_SECONDS)"

test-video-encoder:
	$(TEST_GUARD) --timeout 90 -- python3 -m unittest studio.test_video_resume studio.test_video_resume_integration

test-video-capture:
	$(TEST_GUARD) --timeout 60 -- node studio/test_video_capture.cjs

test-browser:
	$(TEST_GUARD) --network --timeout 360 -- $(MAKE) _test-browser

_test-browser:
	$(MAKE) test-video-capture
	node studio/test_browser.cjs
