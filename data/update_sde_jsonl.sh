#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_LATEST_FILE="${SCRIPT_DIR}/latest.json"
GROUPS_OUTPUT_FILE="${SCRIPT_DIR}/groups.json"
TYPES_OUTPUT_FILE="${SCRIPT_DIR}/types.json"
REMOTE_LATEST_URL="https://developers.eveonline.com/static-data/tranquility/latest.jsonl"
SDE_ZIP_URL="https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip"
# SDE skill category is 16 (Skill) in current data.
SKILL_CATEGORY_ID="${SKILL_CATEGORY_ID:-16}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd unzip
require_cmd mktemp
require_cmd jq

tmp_dir="$(mktemp -d)"
echo "Using temporary directory: ${tmp_dir}"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

remote_latest_file="${tmp_dir}/latest.remote.json"
zip_file="${tmp_dir}/sde.zip"
unzip_dir="${tmp_dir}/unzipped"
mkdir -p "${unzip_dir}"

curl -fsSL "${REMOTE_LATEST_URL}" -o "${remote_latest_file}"

is_current=0
if [[ -f "${LOCAL_LATEST_FILE}" ]] && cmp -s "${LOCAL_LATEST_FILE}" "${remote_latest_file}"; then
  is_current=1
fi

groups_existing_count=0
types_existing_count=0
if [[ -f "${GROUPS_OUTPUT_FILE}" ]]; then
  groups_existing_count="$(jq 'length' "${GROUPS_OUTPUT_FILE}" 2>/dev/null || echo 0)"
fi
if [[ -f "${TYPES_OUTPUT_FILE}" ]]; then
  types_existing_count="$(jq 'length' "${TYPES_OUTPUT_FILE}" 2>/dev/null || echo 0)"
fi

if [[ "${is_current}" -eq 1 && "${FORCE_REBUILD}" != "1" && "${groups_existing_count}" -gt 0 && "${types_existing_count}" -gt 0 ]]; then
  echo "SDE is already current and output files are populated; no update required."
  exit 0
fi

if [[ "${is_current}" -eq 1 ]]; then
  echo "SDE is current but outputs are empty/missing or forced; rebuilding extracted JSON files..."
else
  echo "New SDE version detected; downloading archive..."
fi

curl -fSL "${SDE_ZIP_URL}" -o "${zip_file}"
unzip -q "${zip_file}" -d "${unzip_dir}"

find_jsonl_file() {
  local file_name="$1"
  find "${unzip_dir}" -type f -name "${file_name}" | head -n 1
}

groups_jsonl="$(find_jsonl_file 'groups.jsonl')"
types_jsonl="$(find_jsonl_file 'types.jsonl')"

if [[ -z "${groups_jsonl}" ]]; then
  echo "Could not find groups.jsonl in downloaded SDE archive" >&2
  exit 1
fi

if [[ -z "${types_jsonl}" ]]; then
  echo "Could not find types.jsonl in downloaded SDE archive" >&2
  exit 1
fi

jq -cs --argjson skill_category_id "${SKILL_CATEGORY_ID}" '
  map(
    select((.categoryID | tonumber?) == $skill_category_id)
    | (._key | tonumber?) as $gid
    | select($gid != null)
    | {
        id: $gid,
        name: (.name.en // .name // .name_en // ""),
      category_id: (.categoryID | tonumber?)
      }
  )
  | sort_by(.id)
  | reduce .[] as $g ({}; .[($g.id | tostring)] = $g)
' "${groups_jsonl}" > "${GROUPS_OUTPUT_FILE}"

skill_group_ids_json="$(jq -r 'keys[]' "${GROUPS_OUTPUT_FILE}" | jq -Rsc 'split("\n") | map(select(length > 0) | tonumber)')"

jq -cs --argjson skill_group_ids "${skill_group_ids_json}" '
  map(
    . as $t
    | ($t.groupID | tonumber?) as $gid
    | ($t._key | tonumber?) as $tid
    | select($gid != null and ($skill_group_ids | index($gid)) != null)
    | select($tid != null)
    | {
        id: $tid,
        name: ($t.name.en // $t.name // $t.name_en // ""),
        group_id: $gid,
        dogma_attributes: (
          ($t.dogma_attributes // $t.dogmaAttributes // [])
          | if type == "array" then . else [] end
          | map(
              {
                attribute_id: (.attribute_id // .attributeID // .id | tonumber?),
                value: (.value // null)
              }
              | select(.attribute_id != null and .value != null)
            )
        )
      }
  )
  | sort_by(.id)
  | reduce .[] as $t ({}; .[($t.id | tostring)] = $t)
' "${types_jsonl}" > "${TYPES_OUTPUT_FILE}"

groups_count="$(jq 'length' "${GROUPS_OUTPUT_FILE}")"
types_count="$(jq 'length' "${TYPES_OUTPUT_FILE}")"
echo "Wrote ${groups_count} skill groups to ${GROUPS_OUTPUT_FILE}"
echo "Wrote ${types_count} skill types to ${TYPES_OUTPUT_FILE}"
if [[ "${groups_count}" -eq 0 || "${types_count}" -eq 0 ]]; then
  echo "Warning: extracted zero rows. Check SKILL_CATEGORY_ID=${SKILL_CATEGORY_ID} against SDE schema." >&2
fi

mv "${remote_latest_file}" "${LOCAL_LATEST_FILE}"
echo "SDE import complete. Updated ${LOCAL_LATEST_FILE}."
