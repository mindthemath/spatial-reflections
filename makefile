.PHONY: serve static build run run-isolated install sync update test test-fast test-guard test-python test-browser test-video-capture test-video-encoder test-video-soak test-video-simple-browser test-agent-api _test-all _test-browser unstick

TEST_GUARD = python3 scripts/test_guard.py

# resumable or simple
VIDEO_MODE ?= resumable
serve:
	python3 studio/server.py --port 1313 --video-mode "$(VIDEO_MODE)"

# When localhost:1313 spins and the server logs nothing, stop the wedged process.
unstick:
	scripts/unstick-server.sh

static:
	python3 -m http.server --directory site 1315

build:
	docker build -t spatial-reflections .

run: build
	mkdir -p raw exports videos
	docker run --rm -ti -p 8000:8000 \
		--user $$(id -u):$$(id -g) \
		-v $$(pwd)/raw:/app/raw:ro \
		-v $$(pwd)/exports:/app/exports:rw \
		-v $$(pwd)/videos:/app/videos:rw \
		spatial-reflections

# No bind mounts: only the baked-in fallback PNGs, and exports/videos vanish with the container.
run-isolated: build
	docker run --rm -ti -p 8000:8000 spatial-reflections

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
	node studio/test_polytope.cjs
	node studio/test_lifecycle_test.cjs
	node studio/test_skybox_hashing.cjs
	node studio/test_video_resume_ui.cjs
	node studio/test_video_export_form.cjs
	node studio/test_drag_drop.cjs
	node studio/test_visual_music.mjs
	python3 -m unittest discover -s studio -p 'test_video_resume.py'
	python3 -m unittest discover -s studio -p 'test_video_simple.py'
	cd studio && python3 -m unittest test_server.ServerStartupTest
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
	$(TEST_GUARD) --timeout 90 -- python3 -m unittest studio.test_video_resume studio.test_video_resume_integration studio.test_video_simple studio.test_video_simple_integration

test-video-capture:
	$(TEST_GUARD) --timeout 60 -- node studio/test_video_capture.cjs

test-video-simple-browser:
	$(TEST_GUARD) --network --timeout 180 -- env TESSERACT_TEST_VIDEO_MODE=simple node studio/test_browser.cjs

test-browser:
	$(TEST_GUARD) --network --timeout 360 -- $(MAKE) _test-browser

test-agent-api:
	$(TEST_GUARD) --network --timeout 180 -- node studio/test_agent_api.cjs

_test-browser:
	$(MAKE) test-video-capture
	node studio/test_browser.cjs
	$(MAKE) test-agent-api
	$(MAKE) test-video-simple-browser
