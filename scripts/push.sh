#!/usr/bin/env bash
# `bun run push <git push args>` — pushes, then runs the workflows locally via wrkflw (CI, + Deploy on master).
set -euo pipefail
git push "$@"
exec bun run scripts/post-push.ts
