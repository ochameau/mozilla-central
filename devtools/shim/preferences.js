/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global pref */

// DevTools add-on is automatically installed on startup if:
// - they were opened once,
// - any DevTools command line argument is passed,
// This pref allow to disable that.
pref("devtools.addon.auto-install", true);

// DevTools add-on install URL.
// >>> DO NOT LAND THAT
// TODO: use final hosting URL on archive.mozilla.org
pref("devtools.addon.install-url", "https://index.taskcluster.net/v1/task/project.devtools.branches.master.build-lint/artifacts/public/devtools.xpi");
