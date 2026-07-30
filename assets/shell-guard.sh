# kimi-subagents shell guard.
# Sourced through BASH_ENV in every Kimi shell invocation of a delegated job.
# The per-job bootstrap sets KIMI_GUARD_ROOTS, KIMI_GUARD_JOB_TYPE,
# KIMI_GUARD_ALLOW_COMMIT and KIMI_GUARD_LOG before sourcing this file.

: "${KIMI_GUARD_LOG:=/dev/null}"
: "${KIMI_GUARD_JOB_TYPE:=analyze}"
: "${KIMI_GUARD_ALLOW_COMMIT:=0}"
: "${KIMI_GUARD_ALLOW_DELETE:=0}"
: "${KIMI_GUARD_ALLOW_INTERPRETERS:=}"
if ! declare -p KIMI_GUARD_READ_ROOTS >/dev/null 2>&1; then KIMI_GUARD_READ_ROOTS=(); fi
KIMI_GUARD_DEPTH=$(( ${KIMI_GUARD_DEPTH:-0} + 1 ))
export KIMI_GUARD_DEPTH

kimi_guard_log() {
  local decision="$1" rule="$2" command="$3" stamp
  [[ "$decision" == "allow" && "$KIMI_GUARD_DEPTH" -gt 1 ]] && return 0
  command=${command//$'\t'/ }
  command=${command//$'\r'/ }
  command=${command//$'\n'/\\n}
  printf -v stamp '%(%Y-%m-%dT%H:%M:%SZ)T' -1
  printf '%s\t%s\t%s\t%s\n' "$stamp" "$decision" "$rule" "$command" >>"$KIMI_GUARD_LOG" 2>/dev/null
}

kimi_guard_deny() {
  kimi_guard_log deny "$1" "$2"
  printf 'kimi-subagents guard: %s\n' "$1" >&2
  exit 126
}

kimi_guard_normalize() {
  local value="${1//\\//}"
  value="${value,,}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  if [[ "$value" =~ ^([a-z]):/(.*)$ ]]; then
    value="/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi
  printf '%s' "$value"
}

kimi_guard_inside_roots() {
  local candidate root
  candidate="$(kimi_guard_normalize "$1")"
  for root in "${KIMI_GUARD_ROOTS[@]}"; do
    [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]] && return 0
  done
  return 1
}

# Read-only roots: readable, never writable. Granted per job via readOnlyRoots.
kimi_guard_inside_read_roots() {
  local candidate root
  candidate="$(kimi_guard_normalize "$1")"
  for root in "${KIMI_GUARD_READ_ROOTS[@]}"; do
    [[ -n "$root" ]] || continue
    [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]] && return 0
  done
  return 1
}

# Discards redirections that write nowhere real, so that a read such as
# `ls "/c/Program Files/..."/* 2> /dev/null` is not mistaken for a write.
kimi_guard_strip_null_redirects() {
  local value="$1"
  value="${value//2>&1/ }"
  while [[ "$value" =~ ([0-9]*\&?\>\>?[[:space:]]*/dev/null) ]]; do
    value="${value/${BASH_REMATCH[1]}/ }"
  done
  printf '%s' "$value"
}

kimi_guard_is_write_command() {
  local probe
  probe="$(kimi_guard_strip_null_redirects "$1")"
  [[ "$probe" =~ (\>|tee|cp[[:space:]]|mv[[:space:]]|touch[[:space:]]|mkdir[[:space:]]|ln[[:space:]]|install[[:space:]]|sed[[:space:]]+-i|rsync|robocopy|xcopy|out-file|set-content|add-content|new-item|remove-item) ]]
}

kimi_guard_is_absolute() {
  local value="${1//\\//}"
  value="${value#[\"\']}"
  value="${value%[\"\']}"
  [[ "$value" == /* || "$value" =~ ^[A-Za-z]:/ ]]
}

kimi_guard_check() {
  local raw="$1"
  local cmd="${raw,,}"
  local allow_rule="default"

  case "$raw" in
    kimi_guard_*|'set -o functrace'|'trap kimi_guard_hook DEBUG'|'shopt -s expand_aliases') return 0 ;;
  esac

  if [[ "$cmd" =~ ^cd[[:space:]]+([^[:space:]\;\&\|]+) ]]; then
    local target="${BASH_REMATCH[1]}"
    if kimi_guard_is_absolute "$target" && ! kimi_guard_inside_roots "$target" && ! kimi_guard_inside_read_roots "$target"; then
      kimi_guard_deny "directory change outside granted roots blocked" "$raw"
    fi
  fi

  if [[ "$KIMI_GUARD_JOB_TYPE" != "execute" ]]; then
    case "$cmd" in
      cd\ *|pwd|true|:) kimi_guard_log allow read-only-navigation "$raw"; return 0 ;;
    esac
    kimi_guard_deny "read-only job: shell command execution blocked" "$raw"
  fi

  if [[ "$KIMI_GUARD_DEPTH" -le 1 && "$KIMI_GUARD_ALLOW_DELETE" != "1" ]] &&
     [[ "$cmd" =~ (^|[[:space:]\;\&\|\(])(rm|rmdir|shred|unlink|del|erase|remove-item)([[:space:]]|$) ]]; then
    kimi_guard_deny "permanent deletion blocked" "$raw"
  fi
  if [[ "$KIMI_GUARD_DEPTH" -le 1 ]] && [[ "$cmd" =~ git[[:space:]]+(clean|filter-branch|gc)([[:space:]]|$) ]]; then
    kimi_guard_deny "destructive git command blocked" "$raw"
  fi
  if [[ "$KIMI_GUARD_DEPTH" -le 1 ]] &&
     { [[ "$cmd" =~ git[[:space:]]+reset[[:space:]]+--hard ]] ||
     [[ "$cmd" =~ git[[:space:]]+stash[[:space:]]+(drop|clear) ]] ||
     [[ "$cmd" =~ git[[:space:]]+branch[[:space:]]+-d ]] ||
     [[ "$cmd" =~ git[[:space:]]+tag[[:space:]]+-d ]] ||
     [[ "$cmd" =~ git[[:space:]]+reflog[[:space:]]+expire ]] ||
     [[ "$cmd" =~ git[[:space:]]+update-ref[[:space:]]+-d ]] ||
     [[ "$cmd" =~ git[[:space:]]+(checkout|restore)[[:space:]]+(--[[:space:]]*)?\.([[:space:]]|$) ]]; }; then
    kimi_guard_deny "destructive git command blocked" "$raw"
  fi
  if [[ "$cmd" =~ git[[:space:]]+(push|remote[[:space:]]+(add|set-url|remove|rename)) ]]; then
    kimi_guard_deny "remote git mutation is main-agent-only" "$raw"
  fi
  if [[ "$cmd" =~ (^|[[:space:]\;\&\|\(])(gh|glab|hub)([[:space:]]|$) ]]; then
    kimi_guard_deny "GitHub or GitLab CLI is main-agent-only" "$raw"
  fi
  if [[ "$cmd" =~ (npm|yarn|pnpm|cargo|poetry|gem|dotnet)[[:space:]]+publish ]] ||
     [[ "$cmd" =~ twine[[:space:]]+upload ]] ||
     [[ "$cmd" =~ (npm|yarn|pnpm)[[:space:]]+(login|adduser|token) ]]; then
    kimi_guard_deny "package publication is main-agent-only" "$raw"
  fi
  if [[ "$cmd" =~ git[[:space:]]+config[[:space:]]+(--global|--system) ]] ||
     [[ "$cmd" =~ (npm|yarn|pnpm)[[:space:]]+config[[:space:]]+set ]]; then
    kimi_guard_deny "global tool configuration changes are blocked" "$raw"
  fi
  if [[ "$KIMI_GUARD_DEPTH" -le 1 ]] && [[ "$cmd" =~ git[[:space:]]+commit([[:space:]]|$) ]] && [[ "$KIMI_GUARD_ALLOW_COMMIT" != "1" ]]; then
    kimi_guard_deny "local commit was not explicitly delegated" "$raw"
  fi
  if [[ "$cmd" =~ (^|[[:space:]\;\&\|\(])(powershell|pwsh|cmd|wsl)(\.exe)?([[:space:]]|$) ]]; then
    local interpreter="${BASH_REMATCH[2]}"
    case " ${KIMI_GUARD_ALLOW_INTERPRETERS} " in
      *" ${interpreter} "*)
        allow_rule="interpreter-delegated" ;;
      *)
        kimi_guard_deny "alternate interpreter escapes the guard and is blocked: ${interpreter}" "$raw" ;;
    esac
  fi
  if [[ "$cmd" =~ (\.ssh/|\.git-credentials|\.npmrc|\.aws/credentials|\.kimi-code/credentials|\.claude/\.credentials|\.codex/auth) ]]; then
    kimi_guard_deny "credential file access blocked" "$raw"
  fi
  if [[ "$cmd" =~ (^|[[:space:]\;\&\|\(])(printenv|env)([[:space:]]|$) ]] ||
     [[ "$cmd" =~ \$\{?[a-z_]*(token|secret|password|credential|api_?key) ]]; then
    kimi_guard_deny "credential or environment export blocked" "$raw"
  fi
  if [[ "$cmd" =~ (curl|wget|invoke-webrequest|invoke-restmethod) ]] &&
     [[ "$cmd" =~ (--data|--form|--upload-file|--post|[[:space:]]-d[[:space:]]|[[:space:]]-f[[:space:]]|[[:space:]]-t[[:space:]]) ]]; then
    kimi_guard_deny "network upload blocked" "$raw"
  fi
  if [[ "$cmd" =~ (curl|wget|iwr).*\|[[:space:]]*(bash|sh|node|python|python3) ]]; then
    kimi_guard_deny "piping downloaded content into an interpreter blocked" "$raw"
  fi

  # Every absolute path in the command is checked, not just the first one.
  local token out_of_root=0
  for token in $(printf '%s' "$raw" | grep -oE '([A-Za-z]:[\\/][^"'"'"'[:space:];|&]*|/[a-z]/[^"'"'"'[:space:];|&]*)' 2>/dev/null); do
    kimi_guard_inside_roots "$token" && continue
    if kimi_guard_is_write_command "$cmd"; then
      if kimi_guard_inside_read_roots "$token"; then
        kimi_guard_deny "read-only root is not writable" "$raw"
      fi
      kimi_guard_deny "write outside granted roots blocked" "$raw"
    fi
    out_of_root=1
  done
  if [[ "$out_of_root" == "1" ]]; then
    [[ "$allow_rule" == "default" ]] && allow_rule="out-of-root-read"
    kimi_guard_log allow "$allow_rule" "$raw"
    return 0
  fi

  kimi_guard_log allow "$allow_rule" "$raw"
  return 0
}

kimi_guard_hook() {
  kimi_guard_check "$BASH_COMMAND"
}

trap kimi_guard_hook DEBUG
set -o functrace
