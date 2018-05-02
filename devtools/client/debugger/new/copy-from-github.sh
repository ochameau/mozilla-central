#!/bin/bash

if [ -d github ]; then
  echo "/!\ 'github' folder already exists. It must not before running this script."
  exit
fi
if [[ -d src || -L src ]]; then
  echo "/!\ 'src' folder already exists. It must not before running this script."
  exit
fi

VERSION=$(cat README.mozilla | grep Version | grep -oE "[0-9.]+")
if [ -z "$VERSION" ]; then
  echo "Unable to compute debugger upstream version from README.mozilla file"
  exit
fi

# Clone julian's branch with necessary tweaks and rebase it against current debugger version used by this m-c revision.
git clone https://github.com/ochameau/debugger.html.git github --branch mc-modules --depth 5
pushd github
git remote add upstream https://github.com/devtools-html/debugger.html.git
BRANCH=release-$VERSION
git fetch upstream $BRANCH --depth 1
git rebase upstream/$BRANCH
popd
ln -s github/src src
