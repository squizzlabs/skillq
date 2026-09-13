#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_LATEST_FILE="${SCRIPT_DIR}/latest.json"
GROUPS_OUTPUT_FILE="${SCRIPT_DIR}/groups.json"
TYPES_OUTPUT_FILE="${SCRIPT_DIR}/types.json"
MASTERIES_OUTPUT_FILE="${SCRIPT_DIR}/masteries.json"
ITEMS_OUTPUT_FILE="${SCRIPT_DIR}/items.json"
TYPE_SHARDS_DIR="${SCRIPT_DIR}/type-shards"
TYPE_SHARD_COUNT=16
REMOTE_LATEST_URL="${REMOTE_LATEST_URL:-https://developers.eveonline.com/static-data/tranquility/latest.jsonl}"
SDE_ZIP_URL="${SDE_ZIP_URL:-https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip}"
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
jq -c . "${remote_latest_file}" > "${remote_latest_file}.normalized"
mv "${remote_latest_file}.normalized" "${remote_latest_file}"

is_current=0
if [[ -f "${LOCAL_LATEST_FILE}" ]] && cmp -s "${LOCAL_LATEST_FILE}" "${remote_latest_file}"; then
  is_current=1
fi

groups_existing_count=0
types_existing_count=0
shards_complete=1
if [[ -f "${GROUPS_OUTPUT_FILE}" ]]; then
  groups_existing_count="$(jq 'length' "${GROUPS_OUTPUT_FILE}" 2>/dev/null || echo 0)"
fi
if [[ -f "${TYPES_OUTPUT_FILE}" ]]; then
  types_existing_count="$(jq 'length' "${TYPES_OUTPUT_FILE}" 2>/dev/null || echo 0)"
fi
for ((shard = 0; shard < TYPE_SHARD_COUNT; shard++)); do
  if [[ ! -s "${TYPE_SHARDS_DIR}/${shard}.json" ]]; then
    shards_complete=0
    break
  fi
done

if [[ "${is_current}" -eq 1 && "${FORCE_REBUILD}" != "1" && "${groups_existing_count}" -gt 0 && "${types_existing_count}" -gt 0 && -s "${ITEMS_OUTPUT_FILE}" && -s "${MASTERIES_OUTPUT_FILE}" && "${shards_complete}" -eq 1 ]]; then
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
certificates_jsonl="$(find_jsonl_file 'certificates.jsonl')"
type_dogma_jsonl="$(find_jsonl_file 'typeDogma.jsonl')"

if [[ -z "${groups_jsonl}" ]]; then
  echo "Could not find groups.jsonl in downloaded SDE archive" >&2
  exit 1
fi

if [[ -z "${types_jsonl}" ]]; then
  echo "Could not find types.jsonl in downloaded SDE archive" >&2
  exit 1
fi

if [[ -z "${certificates_jsonl}" ]]; then
  echo "Could not find certificates.jsonl in downloaded SDE archive" >&2
  exit 1
fi

if [[ -z "${type_dogma_jsonl}" ]]; then
  echo "Could not find typeDogma.jsonl in downloaded SDE archive" >&2
  exit 1
fi

jq -cs '
  map(
    (._key | tonumber?) as $gid
    | select($gid != null)
    | {
        id: $gid,
        name: (.name.en // .name // .name_en // ""),
        category_id: (.categoryID | tonumber?),
        published: (.published // false)
      }
  )
  | sort_by(.id)
  | reduce .[] as $g ({}; .[($g.id | tostring)] = $g)
' "${groups_jsonl}" > "${GROUPS_OUTPUT_FILE}"

dogma_map_file="${tmp_dir}/type-dogma-map.json"
jq -cs '
  reduce .[] as $d ({};
    ($d._key | tonumber?) as $tid
    | if $tid == null then . else
        .[($tid | tostring)] = {
          dogma_attributes: (($d.dogmaAttributes // []) | map({attribute_id: (.attributeID | tonumber), value})),
          dogma_effects: (($d.dogmaEffects // []) | map({effect_id: (.effectID | tonumber), is_default: (.isDefault // false)}))
        }
      end
  )
' "${type_dogma_jsonl}" > "${dogma_map_file}"

skill_group_ids_json="$(jq '[to_entries[] | select(.value.category_id == 16) | (.key | tonumber)]' "${GROUPS_OUTPUT_FILE}")"

# Convert every published item and every skill to the ESI response shape before
# separating the eager-loaded skill catalog from lazy-loaded ordinary items.
all_types_file="${tmp_dir}/all-types.json"
jq -cs --slurpfile dogma "${dogma_map_file}" --argjson skill_group_ids "${skill_group_ids_json}" '
  ($dogma[0] // {}) as $dogma_by_type
  |
  map(
    . as $t
    | ($t.groupID | tonumber?) as $gid
    | ($t._key | tonumber?) as $tid
    | select($gid != null and $tid != null)
    | select($t.published == true or ($skill_group_ids | index($gid)) != null)
    | {
        type_id: $tid,
        name: ($t.name.en // $t.name // $t.name_en // ""),
        description: ($t.description.en // $t.description // null),
        group_id: $gid,
        capacity: ($t.capacity // null),
        graphic_id: ($t.graphicID // null),
        icon_id: ($t.iconID // null),
        market_group_id: ($t.marketGroupID // null),
        mass: ($t.mass // null),
        packaged_volume: ($t.packagedVolume // null),
        portion_size: ($t.portionSize // null),
        published: ($t.published // false),
        radius: ($t.radius // null),
        volume: ($t.volume // null),
        dogma_attributes: ($dogma_by_type[($tid | tostring)].dogma_attributes // []),
        dogma_effects: ($dogma_by_type[($tid | tostring)].dogma_effects // [])
      }
      | with_entries(select(.value != null))
  )
  | sort_by(.type_id)
  | reduce .[] as $t ({}; .[($t.type_id | tostring)] = $t)
' "${types_jsonl}" > "${all_types_file}"

jq -c --argjson skill_group_ids "${skill_group_ids_json}" '
  with_entries(select(.value.group_id as $gid | ($skill_group_ids | index($gid)) != null))
' "${all_types_file}" > "${TYPES_OUTPUT_FILE}"

mkdir -p "${TYPE_SHARDS_DIR}"
for ((shard = 0; shard < TYPE_SHARD_COUNT; shard++)); do
  jq -c --argjson shard "${shard}" --argjson shard_count "${TYPE_SHARD_COUNT}" --argjson skill_group_ids "${skill_group_ids_json}" '
    with_entries(select(
      ((.key | tonumber) % $shard_count) == $shard
      and (.value.group_id as $gid | ($skill_group_ids | index($gid)) == null)
    ))
  ' "${all_types_file}" > "${TYPE_SHARDS_DIR}/${shard}.json"
done

groups_count="$(jq 'length' "${GROUPS_OUTPUT_FILE}")"
types_count="$(jq 'length' "${TYPES_OUTPUT_FILE}")"
echo "Wrote ${groups_count} groups to ${GROUPS_OUTPUT_FILE}"
echo "Wrote ${types_count} skill types to ${TYPES_OUTPUT_FILE}"
if [[ "${groups_count}" -eq 0 || "${types_count}" -eq 0 ]]; then
  echo "Warning: extracted zero rows. Check the current SDE schema." >&2
fi

# Compact search index; detailed item records live in type-shards/.
jq -c '[
  .[]
  | select(.published == true)
  | {id: .type_id, name}
    + (if any(.dogma_attributes[]?;
        .attribute_id == 182 or .attribute_id == 183 or .attribute_id == 184
        or .attribute_id == 1285 or .attribute_id == 1289 or .attribute_id == 1290
      ) then {hasRequirements: true} else {} end)
] | sort_by(.name)' "${all_types_file}" > "${ITEMS_OUTPUT_FILE}"

# Ship mastery skills. Each certificate maps its recommended ships to the
# five in-game mastery levels; merge certificates by taking the highest level
# requested for each skill.
jq -cs '
  reduce .[] as $cert ({};
    reduce ($cert.recommendedFor // [])[] as $ship (.;
      reduce ($cert.skillTypes // [])[] as $skill (.;
        reduce ([
          {level: 1, value: $skill.basic},
          {level: 2, value: $skill.standard},
          {level: 3, value: $skill.improved},
          {level: 4, value: $skill.advanced},
          {level: 5, value: $skill.elite}
        ] | map(select(.value > 0)))[] as $req (.;
          .[($ship | tostring)][($req.level | tostring)][($skill._key | tostring)] =
            ([.[$ship | tostring][$req.level | tostring][($skill._key | tostring)] // 0, $req.value] | max)
        )
      )
    )
  )
  | with_entries(.value |= with_entries(.value |= (to_entries | map({typeID: (.key | tonumber), requiredSkillLevel: .value}))))
' "${certificates_jsonl}" > "${MASTERIES_OUTPUT_FILE}"

mv "${remote_latest_file}" "${LOCAL_LATEST_FILE}"
echo "SDE import complete. Updated ${LOCAL_LATEST_FILE}."
