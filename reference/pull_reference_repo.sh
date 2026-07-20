#!/bin/sh

BASE_DIR="${BASE_DIR:-$PWD}"

# One repo name per line. Add or remove entries here.
REPO_LIST=$(cat <<'EOF'
awesome-loop-engineering
DoWhiz
loop-engineering
oh-my-openagent
ralph-orchestrator
EOF
)

if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed or not in PATH."
  exit 1
fi

success_count=0
skip_count=0
fail_count=0

for repo in $REPO_LIST; do
  repo_dir="$BASE_DIR/$repo"

  echo "==> $repo"

  if [ ! -d "$repo_dir" ]; then
    echo "  Skip: directory not found: $repo_dir"
    skip_count=$((skip_count + 1))
    echo
    continue
  fi

  if [ ! -d "$repo_dir/.git" ]; then
    echo "  Skip: not a git repository: $repo_dir"
    skip_count=$((skip_count + 1))
    echo
    continue
  fi

  (
    cd "$repo_dir" || exit 1

    if git pull; then
      if git fetch --prune; then
        echo "  Done"
        exit 0
      fi

      echo "  Failed: git fetch --prune"
      exit 2
    fi

    echo "  Failed: git pull"
    exit 3
  )

  status=$?

  if [ "$status" -eq 0 ]; then
    success_count=$((success_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi

  echo
done

echo "Finished: success=$success_count, skipped=$skip_count, failed=$fail_count"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
