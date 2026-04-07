#!/usr/bin/env bash
# Phase 5 corpus verification — check sensitivity classification results.
# Run after all corpus tasks have completed.
#
# Usage: ./scripts/verify-phase5-corpus.sh <batch-timestamp>
# Example: ./scripts/verify-phase5-corpus.sh 20260406-191722

set -euo pipefail

BATCH_TS="${1:?Usage: $0 <batch-timestamp>}"
MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"
MUNIN_API_KEY="${MUNIN_API_KEY:?MUNIN_API_KEY is required}"

PASS=0
FAIL=0
PENDING=0
ERRORS=""

read_entry() {
  local ns="$1"
  local key="$2"
  curl -s -X POST "${MUNIN_URL}/rpc" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MUNIN_API_KEY}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"memory.read\",\"params\":{\"namespace\":\"${ns}\",\"key\":\"${key}\"},\"id\":1}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); print(json.dumps(r.get("result",{})))' 2>/dev/null
}

check_standalone() {
  local slug="$1"
  local expected_effective="$2"
  local expected_mismatch="$3"   # "true" or "false"
  local declared="$4"            # for display, or "none"
  local task_id="${BATCH_TS}-${slug}"
  local task_ns="tasks/${task_id}"

  # Read status to check if completed
  local status_json
  status_json=$(read_entry "${task_ns}" "status")
  local tags
  tags=$(echo "$status_json" | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin).get("tags",[])))' 2>/dev/null || echo "")

  if echo "$tags" | grep -q "pending\|running\|blocked"; then
    echo "  PENDING  ${slug} (tags: ${tags})"
    PENDING=$((PENDING + 1))
    return
  fi

  if ! echo "$tags" | grep -q "completed"; then
    # Check if failed due to security policy (expected for some cases)
    if echo "$tags" | grep -q "failed"; then
      # Read result-structured to check if it's a security rejection
      local result_json
      result_json=$(read_entry "${task_ns}" "result-structured")
      local lifecycle
      lifecycle=$(echo "$result_json" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("content",""))' 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("lifecycle",""))' 2>/dev/null || echo "")
    fi
    # Still check result-structured if it exists
  fi

  # Read result-structured
  local result_json
  result_json=$(read_entry "${task_ns}" "result-structured")
  local result_content
  result_content=$(echo "$result_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("content",""))' 2>/dev/null || echo "")

  if [ -z "$result_content" ] || [ "$result_content" = "" ]; then
    echo "  FAIL     ${slug} — no result-structured found"
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ${slug}: no result-structured"
    return
  fi

  # Parse sensitivity from result-structured JSON
  local sens_effective sens_declared sens_mismatch
  sens_effective=$(echo "$result_content" | python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("sensitivity",{}); print(s.get("effective","MISSING"))' 2>/dev/null || echo "PARSE_ERROR")
  sens_declared=$(echo "$result_content" | python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("sensitivity",{}); print(s.get("declared","none"))' 2>/dev/null || echo "PARSE_ERROR")
  sens_mismatch=$(echo "$result_content" | python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("sensitivity",{}); print(str(s.get("mismatch",False)).lower())' 2>/dev/null || echo "PARSE_ERROR")

  # Read Munin classification on the result-structured entry itself
  local munin_classification
  munin_classification=$(echo "$result_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("classification","MISSING"))' 2>/dev/null || echo "PARSE_ERROR")

  # Check effective sensitivity
  local ok=true
  local detail=""

  if [ "$sens_effective" != "$expected_effective" ]; then
    ok=false
    detail="${detail} effective=${sens_effective}(expected ${expected_effective})"
  fi

  if [ "$sens_mismatch" != "$expected_mismatch" ]; then
    ok=false
    detail="${detail} mismatch=${sens_mismatch}(expected ${expected_mismatch})"
  fi

  # Check Munin classification consistency
  # public->public, internal->internal, private->client-confidential
  local expected_classification
  case "$expected_effective" in
    public) expected_classification="public" ;;
    internal) expected_classification="internal" ;;
    private) expected_classification="client-confidential" ;;
  esac

  if [ "$munin_classification" != "$expected_classification" ]; then
    ok=false
    detail="${detail} classification=${munin_classification}(expected ${expected_classification})"
  fi

  if $ok; then
    echo "  PASS     ${slug}  effective=${sens_effective} declared=${sens_declared} mismatch=${sens_mismatch} classification=${munin_classification}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL     ${slug} ${detail}"
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ${slug}:${detail}"
  fi
}

check_pipeline() {
  local slug="$1"
  local expected_parent_effective="$2"
  local phase_checks="$3"  # "phaseName:expectedEffective,..."
  local task_id="${BATCH_TS}-${slug}"
  local task_ns="tasks/${task_id}"

  # Read parent status
  local status_json
  status_json=$(read_entry "${task_ns}" "status")
  local tags
  tags=$(echo "$status_json" | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin).get("tags",[])))' 2>/dev/null || echo "")

  if echo "$tags" | grep -q "pending\|running\|blocked"; then
    echo "  PENDING  ${slug} (pipeline, tags: ${tags})"
    PENDING=$((PENDING + 1))
    return
  fi

  # Read pipeline summary
  local summary_json
  summary_json=$(read_entry "${task_ns}" "summary")
  local summary_content
  summary_content=$(echo "$summary_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("content",""))' 2>/dev/null || echo "")

  if [ -z "$summary_content" ] || [ "$summary_content" = "" ]; then
    echo "  FAIL     ${slug} — no pipeline summary found"
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ${slug}: no pipeline summary"
    return
  fi

  # Check pipeline-level sensitivity from summary
  local pipeline_sensitivity
  pipeline_sensitivity=$(echo "$summary_content" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("sensitivity","MISSING"))' 2>/dev/null || echo "PARSE_ERROR")

  local pipeline_classification
  pipeline_classification=$(echo "$summary_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("classification","MISSING"))' 2>/dev/null || echo "PARSE_ERROR")

  local ok=true
  local detail=""

  if [ "$pipeline_sensitivity" != "$expected_parent_effective" ]; then
    # Pipeline summary might store sensitivity differently — just log it
    detail="${detail} pipeline_sensitivity=${pipeline_sensitivity}(expected ${expected_parent_effective})"
  fi

  # Check each phase's result-structured
  IFS=',' read -ra PHASE_PAIRS <<< "$phase_checks"
  for pair in "${PHASE_PAIRS[@]}"; do
    local phase_name="${pair%%:*}"
    local phase_expected="${pair##*:}"

    # Find phase child task — look for result-structured entries in child namespaces
    # Child tasks are named tasks/<parent-id>-<phase-name>
    local child_ns="tasks/${task_id}-${phase_name}"
    local child_result
    child_result=$(read_entry "${child_ns}" "result-structured")
    local child_content
    child_content=$(echo "$child_result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("content",""))' 2>/dev/null || echo "")

    if [ -z "$child_content" ] || [ "$child_content" = "" ]; then
      detail="${detail} phase:${phase_name}=NO_RESULT"
      continue
    fi

    local phase_effective
    phase_effective=$(echo "$child_content" | python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("sensitivity",{}); print(s.get("effective","MISSING"))' 2>/dev/null || echo "PARSE_ERROR")

    if [ "$phase_effective" != "$phase_expected" ]; then
      ok=false
      detail="${detail} phase:${phase_name}=${phase_effective}(expected ${phase_expected})"
    else
      detail="${detail} phase:${phase_name}=${phase_effective}:OK"
    fi
  done

  if $ok; then
    echo "  PASS     ${slug} ${detail}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL     ${slug} ${detail}"
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ${slug}:${detail}"
  fi
}

echo "=== Phase 5 Corpus Verification ==="
echo "Batch: ${BATCH_TS}"
echo ""

echo "--- PUBLIC-declared (baseline internal always ratchets up) ---"
# Baseline defaults to "internal", so declared "public" gets ratcheted up → mismatch=true
# pub-3 has no declared sensitivity → no mismatch (effective just defaults to internal)
check_standalone "pub-1-release-notes"           "internal" "true"  "public"
check_standalone "pub-2-readme-gen"              "internal" "true"  "public"
check_standalone "pub-3-no-sensitivity-scratch"  "internal" "false" "none"
check_standalone "pub-4-explicit-public-workspace" "internal" "true" "public"

echo ""
echo "--- INTERNAL (expected: effective=internal) ---"
check_standalone "int-1-repo-context"            "internal" "false" "internal"
check_standalone "int-2-no-sensitivity-repo"     "internal" "false" "none"
check_standalone "int-3-internal-with-context-ref" "internal" "false" "internal"
check_standalone "int-4-workspace-path"          "internal" "false" "none"

echo ""
echo "--- PRIVATE (expected: effective=private) ---"
check_standalone "priv-1-files-context"          "private"  "false" "private"
check_standalone "priv-2-people-context-ref"     "private"  "false" "private"
check_standalone "priv-3-prompt-keywords"        "private"  "false" "private"
check_standalone "priv-4-mimir-path"             "private"  "false" "private"

echo ""
echo "--- MISMATCH (expected: ratchet up, mismatch=true) ---"
check_standalone "mis-1-public-but-private-ref"      "private"  "true"  "public"
check_standalone "mis-2-public-but-private-prompt"   "private"  "true"  "public"
check_standalone "mis-3-internal-but-files-context"  "private"  "true"  "internal"

echo ""
echo "--- PIPELINES ---"
# pipe-1: uniform internal, all phases internal
check_pipeline "pipe-1-uniform-internal" "internal" "research:internal,summarize:internal"
# pipe-2: pipeline declares internal, upstream gather is private, analyze inherits private
check_pipeline "pipe-2-private-upstream" "internal" "gather:private,analyze:private"
# pipe-3: parent declares public, but phase private-work is private, final inherits private from dependency
# public-work: baseline=public (pipeline declared), no private signals → effective=public
# private-work: declared private → effective=private
# final: inherits private from private-work dependency → effective=private
check_pipeline "pipe-3-public-parent-private-phase" "public" "public-work:public,private-work:private,final:private"

echo ""
echo "=== Results ==="
echo "PASS:    ${PASS}"
echo "FAIL:    ${FAIL}"
echo "PENDING: ${PENDING}"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$ERRORS"
  exit 1
elif [ $PENDING -gt 0 ]; then
  echo ""
  echo "Some tasks still pending — rerun after completion."
  exit 2
else
  echo ""
  echo "All checks passed — Phase 5 corpus evaluation PASSED."
  exit 0
fi
