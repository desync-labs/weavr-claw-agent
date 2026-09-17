#!/bin/sh
# curator-lib.sh: shared by the four curator-*.sh cron scripts (sourced, never
# run). POSIX sh: the Hermes scheduler runs .sh files under bash, the laptop
# rehearsal under whatever /bin/sh is.
#
# Why a library: every script talks to the curator signer the same way:
# bearer CURATOR_SIGNER_TOKEN, X-Curator-Session: cron (the signer treats a
# missing header as cron anyway; sending it makes the journal honest), a caller
# name for the journal, and JSON handled by python3 because the Hermes image
# ships python3 and curl but no jq.
#
# The token reaches curl through a config document on stdin (-K -), never as a
# command-line argument, so it is not visible in `ps` (no key
# material in process arguments). Nothing here prints the token or the URL.
#
# Requires CURATOR_SIGNER_URL and CURATOR_SIGNER_TOKEN in the environment.

# curator_require_env <script-name>: exit 2 and a plain message on stderr when unset
curator_require_env() {
  if [ -z "${CURATOR_SIGNER_URL:-}" ] || [ -z "${CURATOR_SIGNER_TOKEN:-}" ]; then
    echo "$1: CURATOR_SIGNER_URL and CURATOR_SIGNER_TOKEN must be set" >&2
    return 2
  fi
  CURATOR_SIGNER_URL=${CURATOR_SIGNER_URL%/}
  return 0
}

# curator_call <caller> <GET|POST> <path> <outfile> [json-body]
# Writes the response body to <outfile>, sets CURATOR_HTTP_STATUS, returns 0
# only for a transport success with an HTTP status below 400.
curator_call() {
  _caller=$1; _method=$2; _path=$3; _out=$4; _body=${5:-}
  [ -n "$_body" ] || _body='{}'
  CURATOR_HTTP_STATUS=000
  if [ "$_method" = "POST" ]; then
    CURATOR_HTTP_STATUS=$(printf 'header = "Authorization: Bearer %s"\n' "$CURATOR_SIGNER_TOKEN" |
      curl -sS --max-time "${CURATOR_CURL_MAX_TIME:-20}" -K - -o "$_out" -w '%{http_code}' \
        -X POST -H 'Content-Type: application/json' -H 'X-Curator-Session: cron' \
        -H "X-Curator-Caller: $_caller" --data "$_body" "$CURATOR_SIGNER_URL$_path" 2>/dev/null)
  else
    CURATOR_HTTP_STATUS=$(printf 'header = "Authorization: Bearer %s"\n' "$CURATOR_SIGNER_TOKEN" |
      curl -sS --max-time "${CURATOR_CURL_MAX_TIME:-20}" -K - -o "$_out" -w '%{http_code}' \
        -H 'X-Curator-Session: cron' -H "X-Curator-Caller: $_caller" \
        "$CURATOR_SIGNER_URL$_path" 2>/dev/null)
  fi
  _rc=$?
  case "$CURATOR_HTTP_STATUS" in
    [0-9][0-9][0-9]) ;;
    *) CURATOR_HTTP_STATUS=000 ;;
  esac
  [ "$_rc" -eq 0 ] && [ "$CURATOR_HTTP_STATUS" -lt 400 ] && [ "$CURATOR_HTTP_STATUS" -ge 200 ]
}

# curator_tmp: a private temp file; the caller removes it
curator_tmp() {
  mktemp "${TMPDIR:-/tmp}/curator.XXXXXX"
}

# curator_py <python source>: runs it with stdin passed through; 3 when python3 is missing
curator_py() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "$1"
  else
    return 3
  fi
}

# curator_notepad_available: the Hermes CLI can write the job notepad
curator_notepad_available() {
  [ -n "${HERMES_HOME:-}" ] && command -v hermes >/dev/null 2>&1
}
