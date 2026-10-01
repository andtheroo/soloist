#!/usr/bin/env node
// Regenerates all course content (charts, manifests, 100%-speed stems) from src/content.js.
// Slower practice speeds are rendered lazily by the server on first request.
require('../src/content').generateAll();
