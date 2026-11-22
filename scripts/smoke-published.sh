#!/usr/bin/env bash
# Installs the package into an empty folder and runs the README's quick start, on each Node line
# the package supports, in Docker, so nothing from this repo leaks in. Passes when the quick start
# prints 2, the counter's value.
#
# Usage: scripts/smoke-published.sh [version]          (default: package.json's version, from npm)
#        scripts/smoke-published.sh path/to/package.tgz (an `npm pack` tarball, before publishing)
set -euo pipefail

cd "$(dirname "$0")/.."
version="${1:-$(node -p "require('./package.json').version")}"
mount=()
spec="@kylewillett/troupe@$version"
if [[ "$version" == *.tgz ]]; then
  mount=(-v "$(cd "$(dirname "$version")" && pwd)/$(basename "$version"):/pkg.tgz:ro")
  spec=/pkg.tgz
fi
# Keep in step with ci.yml's matrix. The latest of each line, as CI uses.
node_versions=(22 24 26)

# The README's first ts block under "## Quick start", as written. It's TypeScript, which Node runs
# by stripping its types, as it does from 22.18.
quickstart="$(awk '/^## Quick start/{s=1} s&&/^```ts/{c=1;next} c&&/^```/{exit} c' README.md)"
if [[ -z "$quickstart" ]]; then
  echo "No quick start found in README.md" >&2
  exit 1
fi

for node in "${node_versions[@]}"; do
  echo "== Node $node, $spec"
  docker run --rm -i ${mount[@]+"${mount[@]}"} -e SPEC="$spec" -e QUICKSTART="$quickstart" \
    "node:$node-slim" bash -s <<'EOF'
set -euo pipefail
mkdir /app && cd /app
npm init -y >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund "$SPEC"
printf '%s\n' "$QUICKSTART" > main.ts
node --version
out="$(node main.ts)"
echo "main.ts printed: $out"
[[ "$out" == "2" ]]
EOF
done
echo "Quick start works on Node ${node_versions[*]}."
