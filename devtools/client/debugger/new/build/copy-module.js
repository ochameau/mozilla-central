/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

const Babel = require("./babel");
const fs = require("fs");
const _path = require("path");
const { execFileSync } = require("child_process");

const srcPath = process.argv[2];
if (!srcPath || !fs.existsSync(srcPath)) {
  throw new Error("Need to pass a source file: " + srcPath);
}

let dstPath = process.argv[3];
if (!dstPath) {
  throw new Error("Need to pass an empty destination path to put module to: " + dstPath);
}

// For some reason, `mach` pass an absolute path with a `!`...
dstPath = dstPath.replace("!", "");

const mappings = {
  "./source-editor": "devtools/client/sourceeditor/editor",
  "../editor/source-editor": "devtools/client/sourceeditor/editor",
  "./test-flag": "devtools/shared/flags",
  "./fronts-device": "devtools/shared/fronts/device",
  immutable: "devtools/client/shared/vendor/immutable",
  lodash: "devtools/client/shared/vendor/lodash",
  react: "devtools/client/shared/vendor/react",
  "react-dom": "devtools/client/shared/vendor/react-dom",
  "react-dom-factories": "devtools/client/shared/vendor/react-dom-factories",
  "react-redux": "devtools/client/shared/vendor/react-redux",
  redux: "devtools/client/shared/vendor/redux",
  "prop-types": "devtools/client/shared/vendor/react-prop-types",

  "wasmparser/dist/WasmParser": "devtools/client/shared/vendor/WasmParser",
  "wasmparser/dist/WasmDis": "devtools/client/shared/vendor/WasmDis",

  // The excluded files below should not be required while the Debugger runs
  // in Firefox. Here, "devtools/shared/flags" is used as a dummy module.
  "../assets/panel/debugger.properties": "devtools/shared/flags",
  "devtools-connection": "devtools/shared/flags",
  "chrome-remote-interface": "devtools/shared/flags",
  "devtools-launchpad": "devtools/shared/flags",

  "devtools-reps": "devtools/client/shared/components/reps/reps.js",
  "devtools-source-map": "devtools/client/shared/source-map/index.js",
};

// List of vendored modules.
// Should be synchronized with vendors.js
const VENDORS = [
  "classnames",
  "devtools-components",
  "devtools-config",
  "devtools-contextmenu",
  "devtools-environment",
  "devtools-modules",
  "devtools-splitter",
  "devtools-utils",
  "fuzzaldrin-plus",
  "react-transition-group/Transition",
  "reselect",
  "Svg",
  "url",
];

function isRequire(t, node) {
  return node && t.isCallExpression(node) && node.callee.name == "require";
}

/**
 * This Babel plugin is used to transpile a single Debugger module into a module that
 * can be loaded in Firefox via the regular DevTools loader.
 */
function transformMC({ types: t }) {
  return {
    visitor: {
      ModuleDeclaration(path, state) {
        const source = path.node.source;
        const value = source && source.value;
        if (value && value.includes(".css")) {
          path.remove();
        }
      },

      StringLiteral(path, state) {
        const { filePath } = state.opts;
        let value = path.node.value;

        if (!isRequire(t, path.parent)) {
          return;
        }

        // Handle require() to files mapped to other mozilla-central files.
        // e.g. require("devtools-reps")
        //   -> require("devtools/client/shared/components/reps/reps.js")
        if (Object.keys(mappings).includes(value)) {
          path.replaceWith(t.stringLiteral(mappings[value]));
          return;
        }

        // Handle require() to loadash submodules
        // e.g. require("lodash/escapeRegExp")
        //   -> require("devtools/client/shared/vendor/lodash").escapeRegExp
        if (value.startsWith("lodash/")) {
          const lodashSubModule = value.split("/").pop();
          path.replaceWith(
            t.stringLiteral(mappings.lodash)
          );
          path.parentPath.replaceWith(
            t.memberExpression(
              path.parent,
              t.identifier(lodashSubModule)
            )
          );
          return;
        }

        // Handle require() to files bundled in vendor.js.
        // e.g. require("some-module");
        //   -> require("devtools/client/debugger/new/dist/vendors").vendored["some-module"];
        const isVendored = VENDORS.some(vendored => value.endsWith(vendored));
        if (isVendored) {
          // components/shared/Svg is required using various relative paths.
          // Transform paths such as "../shared/Svg" to "Svg".
          if (value.endsWith("/Svg")) {
            value = "Svg";
          }

          // Transform the required path to require vendors.js
          path.replaceWith(
            t.stringLiteral("devtools/client/debugger/new/dist/vendors")
          );

          // Append `.vendored["some-module"]` after the require().
          path.parentPath.replaceWith(
            t.memberExpression(
              t.memberExpression(
                path.parent,
                t.identifier("vendored")
              ),
              t.stringLiteral(value),
              true
            )
          );
          return;
        }

        // Handle implicit index.js requires:
        // in a node environment, require("my/folder") will automatically load
        // my/folder/index.js if available. The DevTools load does not handle
        // this case, so we need to explicitly transform such requires to point
        // to the index.js file.
        const dir = _path.dirname(filePath);
        const depPath = _path.join(dir, `${value}.js`);
        const exists = fs.existsSync(depPath);
        if (
          !exists &&
          !value.endsWith("index") &&
          !value.startsWith("devtools")
        ) {
          path.replaceWith(t.stringLiteral(`${value}/index`));
          return;
        }
      }
    }
  };
};

Babel.registerPlugin("transform-mc", transformMC);

function transform(filePath) {
  const doc = fs.readFileSync(filePath, "utf8");
  const out = Babel.transform(doc, {
    plugins: [
			"transform-flow-strip-types",
			"syntax-trailing-function-commas",
			"transform-class-properties",
			"transform-es2015-modules-commonjs",
			"transform-object-rest-spread",
			"transform-react-jsx",
      ["transform-mc", { mappings, vendors: VENDORS, filePath }]
    ]
  });

  return out.code;
}

const code = transform(srcPath);
execFileSync("mkdir", ["-p", _path.dirname(dstPath)]);
fs.writeFileSync(dstPath, code);
