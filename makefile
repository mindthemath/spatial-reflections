# Copyright 2026 Michael Pilosov. All rights reserved.
.PHONY: serve unstick static refresh-site build run run-isolated install sync update copyright test-copyright test test-fast test-lint test-app test-studio test-video _test-js _test-app-js _test-video-js _test-video-python-fast test-all _test-all test-tools test-guard test-python test-video-backend _test-video-backend test-video-soak test-video-encoder test-app-render test-audio test-video-capture test-app-browser test-studio-browser test-video-browser test-video-simple-browser test-browser test-agent-api _test-browser

# Nested guarded stages must remain serial even under make -j.
.NOTPARALLEL:
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

# Re-snapshot the current viewer runtime into every published work.
refresh-site:
	python3 studio/server.py --refresh-site

build:
	docker build -t spatial-reflections .

run: build
	mkdir -p raw exports videos
	docker run --rm -ti -p 8000:8000 \
		--user $$(id -u):$$(id -g) \
		-v $$(pwd)/raw:/app/raw:ro \
		-v $$(pwd)/exports:/app/exports:rw \
		-v $$(pwd)/videos:/app/videos:rw \
		-v $$(pwd)/site:/app/site:rw \
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
	# Validate every domain after dependency updates, not just the fast default.
	$(MAKE) test-all

# Propagate the canonical notice in SOURCE_RIGHTS.txt to all first-party source files,
# and the one in DISTRIBUTION_RIGHTS.txt into published image metadata.
copyright:
	python3 scripts/copyright_headers.py
	python3 scripts/image_copyright.py

test-copyright:
	python3 scripts/copyright_headers.py --check
	python3 scripts/image_copyright.py --check

# Default feedback is cheap. Browsers/encoders and infrastructure tests are opt-in.
test: test-fast

test-fast:
	$(MAKE) test-lint _test-js _test-video-python-fast

test-lint: test-copyright
	bun run test:vendor
	bun run test:syntax

# Domain targets are independent: no Chromium or real encoder.
# Studio API tests use an isolated localhost server.
test-app: _test-app-js

test-studio:
	node studio/test_resolution.cjs
	$(TEST_GUARD) --network --timeout 60 -- python3 -m unittest discover -s studio -p 'test_server.py'

test-video:
	$(MAKE) _test-video-js _test-video-python-fast

_test-js:
	$(MAKE) _test-app-js _test-video-js
	node studio/test_resolution.cjs

_test-app-js:
	node studio/test_polytope.cjs
	node studio/test_skybox_hashing.cjs
	node studio/test_drag_drop.cjs
	node studio/test_sound_frame.cjs
	node studio/test_visual_music.mjs

_test-video-js:
	node studio/test_video_resume_ui.cjs
	node studio/test_video_export_form.cjs

_test-video-python-fast:
	python3 -m unittest discover -s studio -p 'test_video_resume.py'
	python3 -m unittest discover -s studio -p 'test_video_simple.py'
	python3 -m unittest studio.test_video_audio studio.test_video_encoding studio.test_video_naming
	cd studio && python3 -m unittest test_server_video.ServerStartupTest

# Full validation is explicit, serialized, and runs each test file once.
test-all:
	$(TEST_GUARD) --network --timeout 600 -- $(MAKE) _test-all

_test-all:
	$(MAKE) test-lint _test-js test-python test-tools test-browser

test-tools: test-guard
	node studio/test_lifecycle_test.cjs

test-guard:
	python3 -m unittest discover -s scripts -p 'test_test_guard.py'

test-python:
	$(TEST_GUARD) --network --timeout 180 -- python3 -m unittest discover -s studio -p 'test_*.py'
	$(TEST_GUARD) --timeout 60 -- python3 -m unittest discover -s scripts -p 'test_audio_diff.py'
	$(TEST_GUARD) --timeout 60 -- python3 -m unittest discover -s scripts -p 'test_image_copyright.py'

# Video backend only: no Studio API, app browser, or unrelated tools.
test-video-backend:
	$(TEST_GUARD) --network --timeout 180 -- $(MAKE) _test-video-backend

_test-video-backend:
	cd studio && python3 -m unittest test_server_video
	$(MAKE) test-video-encoder

VIDEO_SOAK_SECONDS ?= 6
test-video-soak:
	$(TEST_GUARD) --timeout 7200 -- python3 studio/video_soak.py --source "$(VIDEO_SOAK_SOURCE)" --seconds "$(VIDEO_SOAK_SECONDS)"

test-video-encoder:
	$(TEST_GUARD) --timeout 120 -- python3 -m unittest studio.test_video_resume studio.test_video_resume_integration studio.test_video_simple studio.test_video_simple_integration studio.test_video_audio studio.test_video_audio_integration studio.test_video_encoding studio.test_video_naming
	$(TEST_GUARD) --timeout 60 -- python3 -m unittest discover -s scripts -p 'test_audio_diff.py'

test-app-render:
	$(TEST_GUARD) --timeout 120 -- node studio/test_lighting.cjs

test-audio:
	$(TEST_GUARD) --timeout 120 -- node studio/test_music_timeline.cjs

test-video-capture:
	$(TEST_GUARD) --timeout 60 -- node studio/test_video_capture.cjs

test-app-browser:
	$(TEST_GUARD) --network --timeout 180 -- node studio/test_app_browser.cjs

test-studio-browser:
	$(TEST_GUARD) --network --timeout 180 -- node studio/test_studio_browser.cjs

test-video-browser:
	$(TEST_GUARD) --network --timeout 180 -- node studio/test_video_browser.cjs

test-video-simple-browser:
	$(TEST_GUARD) --network --timeout 180 -- env TESSERACT_TEST_VIDEO_MODE=simple node studio/test_video_browser.cjs

test-browser:
	$(TEST_GUARD) --network --timeout 360 -- $(MAKE) _test-browser

test-agent-api:
	$(TEST_GUARD) --network --timeout 180 -- node studio/test_agent_api.cjs

_test-browser:
	$(MAKE) test-app-render test-audio test-video-capture test-studio-browser test-app-browser test-video-browser test-video-simple-browser test-agent-api
